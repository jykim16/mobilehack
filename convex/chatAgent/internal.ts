import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { notFound } from "../lib/auth";
import { quote, targetAppliesTo } from "../lib/validators";
import { removeItemFor, setQuantityFor, updateDecisionFor } from "../model/cart";
import { decideFor, listPurchasesFor } from "../model/purchases";
import { offerView } from "../model/views";
import {
  agentCardValidator,
  amazonClientActionValidator,
  assertValidCards,
  chatMessageStatusValidator,
  chatThreadStatusValidator,
} from "./validators";

export const getThreadContext = internalQuery({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, { threadId }) => {
    const thread = await ctx.db.get("chatThreads", threadId);
    if (!thread) return null;
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", threadId))
      .order("asc")
      .take(100);
    return { thread, messages };
  },
});

export const appendAssistantMessage = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
    cards: v.array(agentCardValidator),
    clientActions: v.optional(v.array(amazonClientActionValidator)),
    status: v.optional(chatMessageStatusValidator),
    threadStatus: v.optional(chatThreadStatusValidator),
    activeClarificationId: v.optional(v.union(v.string(), v.null())),
    pendingRequestId: v.optional(v.union(v.id("purchaseRequests"), v.null())),
    lastError: v.optional(v.union(v.string(), v.null())),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("chatThreads", args.threadId);
    if (!thread) notFound("Chat thread");

    if (args.idempotencyKey) {
      const existing = await ctx.db
        .query("chatMessages")
        .withIndex("by_threadId_and_idempotencyKey", (q) =>
          q.eq("threadId", args.threadId).eq("idempotencyKey", args.idempotencyKey),
        )
        .unique();
      if (existing) {
        return { messageId: existing._id, deduplicated: true };
      }
    }

    const now = Date.now();
    const validatedCards = assertValidCards(args.cards);
    const messageId = await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      shopperId: thread.shopperId,
      role: "assistant",
      text: args.text,
      cards: validatedCards,
      clientActions:
        args.clientActions && args.clientActions.length > 0 ? args.clientActions : undefined,
      status: args.status ?? "complete",
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });

    const patch: {
      status?: typeof thread.status;
      activeClarificationId?: string | undefined;
      pendingRequestId?: Id<"purchaseRequests"> | undefined;
      lastError?: string | undefined;
      updatedAt: number;
    } = { updatedAt: now };

    if (args.threadStatus !== undefined) {
      patch.status = args.threadStatus;
    }
    if (args.activeClarificationId !== undefined) {
      patch.activeClarificationId = args.activeClarificationId ?? undefined;
    }
    if (args.pendingRequestId !== undefined) {
      patch.pendingRequestId = args.pendingRequestId ?? undefined;
    }
    if (args.lastError !== undefined) {
      patch.lastError = args.lastError ?? undefined;
    }

    await ctx.db.patch("chatThreads", args.threadId, patch);
    return { messageId, deduplicated: false };
  },
});

export const setThreadState = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    status: chatThreadStatusValidator,
    activeClarificationId: v.optional(v.union(v.string(), v.null())),
    pendingRequestId: v.optional(v.union(v.id("purchaseRequests"), v.null())),
    lastError: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get("chatThreads", args.threadId);
    if (!thread) return null;
    const patch: {
      status: typeof args.status;
      activeClarificationId?: string | undefined;
      pendingRequestId?: Id<"purchaseRequests"> | undefined;
      lastError?: string | undefined;
      updatedAt: number;
    } = {
      status: args.status,
      updatedAt: Date.now(),
    };
    if (args.activeClarificationId !== undefined) {
      patch.activeClarificationId = args.activeClarificationId ?? undefined;
    }
    if (args.pendingRequestId !== undefined) {
      patch.pendingRequestId = args.pendingRequestId ?? undefined;
    }
    if (args.lastError !== undefined) {
      patch.lastError = args.lastError ?? undefined;
    }
    await ctx.db.patch("chatThreads", args.threadId, patch);
    return null;
  },
});

export const patchCheckoutCard = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    requestId: v.string(),
    status: v.union(
      v.literal("pending_approval"),
      v.literal("approved"),
      v.literal("deferred"),
      v.literal("expired"),
      v.literal("stale"),
    ),
    quoteVersion: v.optional(v.number()),
    quote: v.optional(quote),
    expiresAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(50);

    for (const msg of messages) {
      let changed = false;
      const nextCards = msg.cards.map((card) => {
        if (card.kind === "checkout_approval" && card.requestId === args.requestId) {
          changed = true;
          return {
            ...card,
            status: args.status,
            quoteVersion: args.quoteVersion ?? card.quoteVersion,
            quote: args.quote ?? card.quote,
            expiresAt: args.expiresAt ?? card.expiresAt,
          };
        }
        return card;
      });
      if (changed) {
        await ctx.db.patch("chatMessages", msg._id, { cards: nextCards });
        break;
      }
    }
    return null;
  },
});

export const getCheckpointTuple = internalQuery({
  args: {
    threadId: v.id("chatThreads"),
    checkpointNs: v.string(),
    checkpointId: v.optional(v.string()),
  },
  handler: async (ctx, { threadId, checkpointNs, checkpointId }) => {
    const checkpoint = checkpointId
      ? await ctx.db
          .query("chatCheckpoints")
          .withIndex("by_thread_ns_and_checkpoint", (q) =>
            q
              .eq("threadId", threadId)
              .eq("checkpointNs", checkpointNs)
              .eq("checkpointId", checkpointId),
          )
          .unique()
      : await ctx.db
          .query("chatCheckpoints")
          .withIndex("by_thread_ns_and_checkpoint", (q) =>
            q.eq("threadId", threadId).eq("checkpointNs", checkpointNs),
          )
          .order("desc")
          .first();

    if (!checkpoint) return null;

    const writes = await ctx.db
      .query("chatCheckpointWrites")
      .withIndex("by_thread_ns_and_checkpoint", (q) =>
        q
          .eq("threadId", threadId)
          .eq("checkpointNs", checkpointNs)
          .eq("checkpointId", checkpoint.checkpointId),
      )
      .take(500);

    return { checkpoint, writes };
  },
});

export const listCheckpointTuples = internalQuery({
  args: {
    threadId: v.id("chatThreads"),
    checkpointNs: v.optional(v.string()),
    checkpointId: v.optional(v.string()),
    beforeCheckpointId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const cap = Math.min(args.limit ?? 50, 100);
    const rows =
      args.checkpointNs !== undefined
        ? await ctx.db
            .query("chatCheckpoints")
            .withIndex("by_thread_ns_and_checkpoint", (q) =>
              q.eq("threadId", args.threadId).eq("checkpointNs", args.checkpointNs!),
            )
            .order("desc")
            .take(200)
        : await ctx.db
            .query("chatCheckpoints")
            .withIndex("by_threadId", (q) => q.eq("threadId", args.threadId))
            .order("desc")
            .take(200);

    const filtered = rows
      .filter((row) => {
        if (args.checkpointId && row.checkpointId !== args.checkpointId) return false;
        if (args.beforeCheckpointId && row.checkpointId >= args.beforeCheckpointId) return false;
        return true;
      })
      .sort((a, b) => (a.checkpointId < b.checkpointId ? 1 : a.checkpointId > b.checkpointId ? -1 : 0))
      .slice(0, cap);

    return await Promise.all(
      filtered.map(async (checkpoint) => {
        const writes = await ctx.db
          .query("chatCheckpointWrites")
          .withIndex("by_thread_ns_and_checkpoint", (q) =>
            q
              .eq("threadId", args.threadId)
              .eq("checkpointNs", checkpoint.checkpointNs)
              .eq("checkpointId", checkpoint.checkpointId),
          )
          .take(500);
        return { checkpoint, writes };
      }),
    );
  },
});

export const putCheckpoint = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    checkpointNs: v.string(),
    checkpointId: v.string(),
    parentCheckpointId: v.optional(v.string()),
    checkpointSerdeType: v.string(),
    checkpointPayload: v.string(),
    metadataSerdeType: v.string(),
    metadataPayload: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("chatCheckpoints")
      .withIndex("by_thread_ns_and_checkpoint", (q) =>
        q
          .eq("threadId", args.threadId)
          .eq("checkpointNs", args.checkpointNs)
          .eq("checkpointId", args.checkpointId),
      )
      .unique();

    if (existing) {
      await ctx.db.patch("chatCheckpoints", existing._id, {
        parentCheckpointId: args.parentCheckpointId,
        checkpointSerdeType: args.checkpointSerdeType,
        checkpointPayload: args.checkpointPayload,
        metadataSerdeType: args.metadataSerdeType,
        metadataPayload: args.metadataPayload,
      });
      return existing._id;
    }

    return await ctx.db.insert("chatCheckpoints", {
      ...args,
      createdAt: Date.now(),
    });
  },
});

export const putCheckpointWrites = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    checkpointNs: v.string(),
    checkpointId: v.string(),
    writes: v.array(
      v.object({
        taskId: v.string(),
        idx: v.number(),
        channel: v.string(),
        serdeType: v.string(),
        payload: v.string(),
        taskPath: v.string(),
      }),
    ),
  },
  handler: async (ctx, { threadId, checkpointNs, checkpointId, writes }) => {
    for (const w of writes) {
      const existing = await ctx.db
        .query("chatCheckpointWrites")
        .withIndex("by_thread_ns_checkpoint_task_and_idx", (q) =>
          q
            .eq("threadId", threadId)
            .eq("checkpointNs", checkpointNs)
            .eq("checkpointId", checkpointId)
            .eq("taskId", w.taskId)
            .eq("idx", w.idx),
        )
        .unique();

      if (existing) {
        if (w.idx >= 0) continue;
        await ctx.db.patch("chatCheckpointWrites", existing._id, {
          channel: w.channel,
          serdeType: w.serdeType,
          payload: w.payload,
          taskPath: w.taskPath,
        });
      } else {
        await ctx.db.insert("chatCheckpointWrites", {
          threadId,
          checkpointNs,
          checkpointId,
          ...w,
        });
      }
    }
    return null;
  },
});

export const deleteThreadCheckpoints = internalMutation({
  args: { threadId: v.id("chatThreads") },
  handler: async (ctx, { threadId }) => {
    const cps = await ctx.db
      .query("chatCheckpoints")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(500);
    for (const cp of cps) {
      await ctx.db.delete("chatCheckpoints", cp._id);
    }
    const writes = await ctx.db
      .query("chatCheckpointWrites")
      .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
      .take(2000);
    for (const w of writes) {
      await ctx.db.delete("chatCheckpointWrites", w._id);
    }
    return null;
  },
});

export const searchCatalog = internalQuery({
  args: { query: v.optional(v.string()) },
  handler: async (ctx, { query }) => {
    const products = await ctx.db.query("products").take(50);
    const terms = (query ?? "")
      .toLowerCase()
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);

    const hydrated = await Promise.all(
      products.map(async (product) => {
        const variants = await ctx.db
          .query("variants")
          .withIndex("by_productId", (q) => q.eq("productId", product._id))
          .take(20);
        const variantMap = new Map<Id<"variants">, string>(
          variants.map((vr) => [vr._id, vr.label]),
        );
        const offerDocs = await ctx.db
          .query("offers")
          .withIndex("by_productId", (q) => q.eq("productId", product._id))
          .take(20);
        const offers = offerDocs.map((o) => offerView(o, variantMap.get(o.variantId) ?? null));
        const haystack = [
          product.title,
          product.brand ?? "",
          product.category,
          product.description ?? "",
          product.demoKey ?? "",
          ...variants.map((vr) => `${vr.label} ${vr.sku ?? ""}`),
          ...offers.map((o) => `${o.retailerName} ${o.url}`),
        ]
          .join(" ")
          .toLowerCase();
        const score =
          terms.length === 0
            ? 1
            : terms.reduce((acc, term) => (haystack.includes(term) ? acc + 1 : acc), 0);
        return {
          product: {
            id: product._id,
            title: product.title,
            brand: product.brand ?? null,
            category: product.category,
            imageUrl: product.imageUrl ?? null,
            description: product.description ?? null,
            demoKey: product.demoKey ?? null,
          },
          variants: variants.map((vr) => ({ id: vr._id, label: vr.label, sku: vr.sku ?? null })),
          offers,
          score,
        };
      }),
    );

    return hydrated
      .filter((entry) => terms.length === 0 || entry.score > 0)
      .sort((a, b) => b.score - a.score);
  },
});

export const updateItemDecision = internalMutation({
  args: {
    shopperId: v.id("users"),
    itemId: v.id("cartItems"),
    priorities: v.array(v.string()),
    targetCents: v.optional(v.number()),
    targetAppliesTo: v.optional(targetAppliesTo),
  },
  handler: async (ctx, { shopperId, ...args }) => updateDecisionFor(ctx, shopperId, args),
});

export const setItemQuantity = internalMutation({
  args: {
    shopperId: v.id("users"),
    itemId: v.id("cartItems"),
    quantity: v.number(),
  },
  handler: async (ctx, { shopperId, itemId, quantity }) =>
    setQuantityFor(ctx, shopperId, itemId, quantity),
});

export const removeCartItem = internalMutation({
  args: {
    shopperId: v.id("users"),
    itemId: v.id("cartItems"),
  },
  handler: async (ctx, { shopperId, itemId }) => removeItemFor(ctx, shopperId, itemId),
});

export const listPurchasesInternal = internalQuery({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => listPurchasesFor(ctx, shopperId),
});

export const decidePurchaseForThread = internalMutation({
  args: {
    shopperId: v.id("users"),
    threadId: v.id("chatThreads"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    decision: v.union(v.literal("approve"), v.literal("defer")),
  },
  handler: async (ctx, { shopperId, threadId, requestId, quoteVersion, decision }) => {
    const thread = await ctx.db.get("chatThreads", threadId);
    if (!thread || thread.shopperId !== shopperId) {
      notFound("Chat thread");
    }

    const res = await decideFor(ctx, shopperId, { requestId, quoteVersion, decision });
    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(50);

    const nextCardStatus =
      res.outcome === "approved" || res.outcome === "already_approved"
        ? ("approved" as const)
        : res.outcome === "deferred"
          ? ("deferred" as const)
          : res.outcome === "expired"
            ? ("expired" as const)
            : res.outcome === "stale_quote"
              ? res.request.quote
                ? ("pending_approval" as const)
                : ("stale" as const)
              : null;

    if (nextCardStatus) {
      for (const msg of messages) {
        let changed = false;
        const nextCards = msg.cards.map((card) => {
          if (card.kind === "checkout_approval" && card.requestId === requestId) {
            changed = true;
            return {
              ...card,
              status: nextCardStatus,
              quoteVersion: res.request.quoteVersion,
              quote: res.request.quote ?? card.quote,
              expiresAt: res.request.expiresAt,
            };
          }
          return card;
        });
        if (changed) {
          await ctx.db.patch("chatMessages", msg._id, { cards: nextCards });
          break;
        }
      }
    }

    const shouldResumeGraph =
      thread.status === "awaiting_approval" &&
      thread.pendingRequestId === requestId &&
      (res.outcome === "approved" ||
        res.outcome === "already_approved" ||
        res.outcome === "deferred" ||
        res.outcome === "expired");

    const now = Date.now();
    if (shouldResumeGraph) {
      await ctx.db.patch("chatThreads", threadId, {
        status: "running",
        lastError: undefined,
        updatedAt: now,
      });
    } else if (res.outcome === "stale_quote" && res.request.status === "pending_approval") {
      await ctx.db.patch("chatThreads", threadId, {
        status: "awaiting_approval",
        pendingRequestId: requestId,
        updatedAt: now,
      });
    }

    return {
      outcome: res.outcome,
      request: res.request,
      shouldResumeGraph,
    };
  },
});
