import { ConvexError, v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { action, mutation, query, type QueryCtx } from "../_generated/server";
import { notFound, requireShopper } from "../lib/auth";
import type { requestView } from "../model/purchases";
import {
  amazonSessionContextValidator,
  clarificationAnswersValidator,
  type AgentCard,
} from "./validators";

type PurchaseRequestView = Awaited<ReturnType<typeof requestView>>;
type DecidePurchaseOutcome =
  | "approved"
  | "already_approved"
  | "deferred"
  | "stale_quote"
  | "expired"
  | "invalid_state";

async function loadOwnedThread(
  ctx: QueryCtx,
  shopperId: Id<"users">,
  threadId: Id<"chatThreads">,
): Promise<Doc<"chatThreads">> {
  const thread = await ctx.db.get("chatThreads", threadId);
  if (!thread || thread.shopperId !== shopperId) {
    notFound("Chat thread");
  }
  return thread;
}

async function hydrateMessageCards(
  ctx: QueryCtx,
  shopperId: Id<"users">,
  cards: AgentCard[],
): Promise<AgentCard[]> {
  return await Promise.all(
    cards.map(async (card) => {
      if (card.kind === "order_receipt") {
        const orderId = ctx.db.normalizeId("orders", card.orderId);
        if (!orderId) return card;
        const order = await ctx.db.get("orders", orderId);
        if (!order || order.shopperId !== shopperId) return card;
        const shipment = await ctx.db
          .query("shipments")
          .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
          .unique();
        return {
          ...card,
          status: order.status,
          quote: order.quote,
          simulated: order.simulated,
          shipment: shipment
            ? {
                status: shipment.status,
                carrier: shipment.carrier ?? null,
                trackingNumber: shipment.trackingNumber ?? null,
                trackingUrl: shipment.trackingUrl ?? null,
                eta: shipment.eta ?? null,
                updatedAt: shipment.updatedAt,
                simulated: shipment.simulated,
              }
            : card.shipment,
        };
      }

      if (card.kind === "checkout_approval" && card.status === "pending_approval") {
        const requestId = ctx.db.normalizeId("purchaseRequests", card.requestId);
        if (!requestId) return card;
        const req = await ctx.db.get("purchaseRequests", requestId);
        if (!req || req.shopperId !== shopperId) return card;
        if (req.status === "expired") {
          return { ...card, status: "expired" as const };
        }
        if (req.status === "deferred") {
          return { ...card, status: "deferred" as const };
        }
        if (req.status === "approved" || req.status === "ordered") {
          return { ...card, status: "approved" as const };
        }
        if (req.quote && req.quoteVersion !== card.quoteVersion) {
          return {
            ...card,
            quoteVersion: req.quoteVersion,
            quote: req.quote,
            expiresAt: req.expiresAt,
          };
        }
      }

      return card;
    }),
  );
}

export const getOrCreateThread = mutation({
  args: {
    threadId: v.optional(v.id("chatThreads")),
  },
  handler: async (ctx, { threadId }) => {
    const shopperId = await requireShopper(ctx);
    await ctx.runMutation(internal.demo.seedCatalog, {});

    if (threadId) {
      const existing = await loadOwnedThread(ctx, shopperId, threadId);
      return { threadId: existing._id, status: existing.status };
    }

    const latest = await ctx.db
      .query("chatThreads")
      .withIndex("by_shopperId_and_updatedAt", (q) => q.eq("shopperId", shopperId))
      .order("desc")
      .first();

    if (latest) {
      return { threadId: latest._id, status: latest.status };
    }

    const createdId = await ctx.db.insert("chatThreads", {
      shopperId,
      status: "idle",
      runSeq: 0,
      updatedAt: Date.now(),
    });
    return { threadId: createdId, status: "idle" as const };
  },
});

export const createThread = mutation({
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    await ctx.runMutation(internal.demo.seedCatalog, {});
    const threadId = await ctx.db.insert("chatThreads", {
      shopperId,
      status: "idle",
      runSeq: 0,
      updatedAt: Date.now(),
    });
    return { threadId, status: "idle" as const };
  },
});

export const getThread = query({
  args: {
    threadId: v.id("chatThreads"),
  },
  handler: async (ctx, { threadId }) => {
    const shopperId = await requireShopper(ctx);
    const thread = await loadOwnedThread(ctx, shopperId, threadId);
    return {
      threadId: thread._id,
      status: thread.status,
      activeClarificationId: thread.activeClarificationId ?? null,
      pendingRequestId: thread.pendingRequestId ?? null,
      lastError: thread.lastError ?? null,
    };
  },
});

export const listMessages = query({
  args: {
    threadId: v.id("chatThreads"),
  },
  handler: async (ctx, { threadId }) => {
    const shopperId = await requireShopper(ctx);
    await loadOwnedThread(ctx, shopperId, threadId);

    const rows = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", threadId))
      .order("asc")
      .take(200);

    return await Promise.all(
      rows.map(async (row) => {
        const cards = await hydrateMessageCards(ctx, shopperId, row.cards);
        return {
          id: row._id,
          threadId: row.threadId,
          role: row.role,
          text: row.text,
          cards,
          ...(row.clientActions && row.clientActions.length > 0
            ? { clientActions: row.clientActions }
            : {}),
          status: row.status,
          createdAt: row.createdAt,
        };
      }),
    );
  },
});

export const sendMessage = mutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
    idempotencyKey: v.string(),
    amazonContext: v.optional(amazonSessionContextValidator),
  },
  handler: async (ctx, args) => {
    const shopperId = await requireShopper(ctx);
    const thread = await loadOwnedThread(ctx, shopperId, args.threadId);

    const trimmed = args.text.trim();
    if (!trimmed) {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "Message text cannot be empty.",
      });
    }

    const duplicate = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_idempotencyKey", (q) =>
        q.eq("threadId", args.threadId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();
    if (duplicate) {
      return { userMessageId: duplicate._id, status: thread.status };
    }

    const now = Date.now();
    const userMessageId = await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      shopperId,
      role: "user",
      text: trimmed,
      cards: [],
      status: "complete",
      idempotencyKey: args.idempotencyKey,
      createdAt: now,
    });

    const nextSeq = thread.runSeq + 1;

    // If the shopper typed a free-form message while a clarification card was pending,
    // mark that clarification card answered with the freeform reply and resume the checkpoint.
    if (thread.status === "awaiting_clarification" && thread.activeClarificationId) {
      const activeClarId = thread.activeClarificationId;
      const recentMsgs = await ctx.db
        .query("chatMessages")
        .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", args.threadId))
        .order("desc")
        .take(25);

      for (const msg of recentMsgs) {
        let updated = false;
        const nextCards = msg.cards.map((card) => {
          if (
            card.kind === "clarification_request" &&
            card.clarificationId === activeClarId &&
            card.status === "pending"
          ) {
            updated = true;
            return {
              ...card,
              status: "answered" as const,
              answers: { freeform: trimmed },
            };
          }
          return card;
        });
        if (updated) {
          await ctx.db.patch("chatMessages", msg._id, { cards: nextCards });
          break;
        }
      }

      await ctx.db.patch("chatThreads", args.threadId, {
        status: "running",
        activeClarificationId: undefined,
        lastError: undefined,
        amazonContext: args.amazonContext ?? thread.amazonContext,
        runSeq: nextSeq,
        updatedAt: now,
      });

      await ctx.scheduler.runAfter(0, internal.chatAgent.runtime.runTurn, {
        threadId: args.threadId,
        runSeq: nextSeq,
        mode: "resume_clarification_freeform",
        userText: trimmed,
        clarificationId: activeClarId,
      });

      return { userMessageId, status: "running" as const };
    }

    if (thread.status === "awaiting_approval" && thread.pendingRequestId) {
      await ctx.db.patch("chatThreads", args.threadId, {
        status: "running",
        lastError: undefined,
        amazonContext: args.amazonContext ?? thread.amazonContext,
        runSeq: nextSeq,
        updatedAt: now,
      });

      await ctx.scheduler.runAfter(0, internal.chatAgent.runtime.runTurn, {
        threadId: args.threadId,
        runSeq: nextSeq,
        mode: "message_during_approval",
        userText: trimmed,
      });

      return { userMessageId, status: "running" as const };
    }

    await ctx.db.patch("chatThreads", args.threadId, {
      status: "running",
      lastError: undefined,
      amazonContext: args.amazonContext ?? thread.amazonContext,
      runSeq: nextSeq,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.chatAgent.runtime.runTurn, {
      threadId: args.threadId,
      runSeq: nextSeq,
      mode: "new_message",
      userText: trimmed,
    });

    return { userMessageId, status: "running" as const };
  },
});

export const submitClarification = mutation({
  args: {
    threadId: v.id("chatThreads"),
    clarificationId: v.string(),
    answers: clarificationAnswersValidator,
    skipped: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const shopperId = await requireShopper(ctx);
    const thread = await loadOwnedThread(ctx, shopperId, args.threadId);

    const recentMsgs = await ctx.db
      .query("chatMessages")
      .withIndex("by_threadId_and_createdAt", (q) => q.eq("threadId", args.threadId))
      .order("desc")
      .take(30);

    let matchedPending = false;
    let matchedAlreadyResolved = false;

    for (const msg of recentMsgs) {
      let patched = false;
      const nextCards = msg.cards.map((card) => {
        if (
          card.kind === "clarification_request" &&
          card.clarificationId === args.clarificationId
        ) {
          if (card.status !== "pending") {
            matchedAlreadyResolved = true;
            return card;
          }
          matchedPending = true;
          patched = true;
          return {
            ...card,
            status: args.skipped ? ("skipped" as const) : ("answered" as const),
            answers: args.skipped ? undefined : args.answers,
          };
        }
        return card;
      });
      if (patched) {
        await ctx.db.patch("chatMessages", msg._id, { cards: nextCards });
        break;
      }
    }

    if (matchedAlreadyResolved && !matchedPending) {
      return { status: thread.status };
    }

    if (!matchedPending && thread.activeClarificationId !== args.clarificationId) {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "Clarification request is no longer active.",
      });
    }

    const nextSeq = thread.runSeq + 1;
    await ctx.db.patch("chatThreads", args.threadId, {
      status: "running",
      activeClarificationId: undefined,
      lastError: undefined,
      runSeq: nextSeq,
      updatedAt: Date.now(),
    });

    await ctx.scheduler.runAfter(0, internal.chatAgent.runtime.runTurn, {
      threadId: args.threadId,
      runSeq: nextSeq,
      mode: "resume_clarification",
      clarificationId: args.clarificationId,
      answers: args.answers,
      skipped: args.skipped,
    });

    return { status: "running" as const };
  },
});

export const decideCheckout = action({
  args: {
    threadId: v.id("chatThreads"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    decision: v.union(v.literal("approve"), v.literal("defer")),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ outcome: DecidePurchaseOutcome; request: PurchaseRequestView }> => {
    const shopperId = await requireShopper(ctx);
    const decisionRes: {
      outcome: DecidePurchaseOutcome;
      request: PurchaseRequestView;
      shouldResumeGraph: boolean;
    } = await ctx.runMutation(
      internal.chatAgent.internal.decidePurchaseForThread,
      {
        shopperId,
        threadId: args.threadId,
        requestId: args.requestId,
        quoteVersion: args.quoteVersion,
        decision: args.decision,
      },
    );

    let latestRequest: PurchaseRequestView = decisionRes.request;

    // Eagerly run idempotent order submission on approval so material-terms requotes
    // or immediate order placement settle before the receipt card renders.
    if (
      (decisionRes.outcome === "approved" || decisionRes.outcome === "already_approved") &&
      latestRequest.order?.status === "submitting"
    ) {
      await ctx.runAction(internal.orders.submitOrder, {
        orderId: latestRequest.order.orderId as Id<"orders">,
      });
      latestRequest = await ctx.runQuery(internal.agent.getPurchaseStatus, {
        shopperId,
        requestId: args.requestId,
      });

      // If material terms changed between quote and submission, submitOrder resets the
      // request to pending_approval with quoteVersion + 1. Keep the approval gate active!
      if (latestRequest.status === "pending_approval" && latestRequest.quote) {
        await ctx.runMutation(internal.chatAgent.internal.patchCheckoutCard, {
          threadId: args.threadId,
          requestId: args.requestId,
          status: "pending_approval",
          quoteVersion: latestRequest.quoteVersion,
          quote: latestRequest.quote,
          expiresAt: latestRequest.expiresAt,
        });
        await ctx.runMutation(internal.chatAgent.internal.setThreadState, {
          threadId: args.threadId,
          status: "awaiting_approval",
          pendingRequestId: args.requestId,
          lastError: null,
        });
        return {
          outcome: "stale_quote" as const,
          request: latestRequest,
        };
      }
    }

    if (decisionRes.shouldResumeGraph) {
      await ctx.runAction(internal.chatAgent.runtime.resumeCheckout, {
        threadId: args.threadId,
        requestId: args.requestId,
        decision: args.decision,
        outcome: decisionRes.outcome,
      });
      latestRequest = await ctx.runQuery(internal.agent.getPurchaseStatus, {
        shopperId,
        requestId: args.requestId,
      });
    } else if (
      decisionRes.outcome === "approved" &&
      latestRequest.order &&
      latestRequest.quote
    ) {
      // Even if approved outside a live interrupt (e.g. from a later turn), record the receipt idempotently.
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId: args.threadId,
        text: `Order placed (${latestRequest.order.orderRef}) for $${(latestRequest.quote.totalCents / 100).toFixed(2)} total. Tracking updates live under Purchases.`,
        cards: [
          {
            kind: "order_receipt",
            orderId: latestRequest.order.orderId,
            orderRef: latestRequest.order.orderRef,
            requestId: latestRequest.requestId,
            itemId: latestRequest.itemId,
            status: latestRequest.order.status,
            quote: latestRequest.quote,
            shipment: latestRequest.shipment,
            simulated: latestRequest.order.simulated,
          },
        ],
        clientActions:
          latestRequest.quote.retailer === "amazon" ? [{ type: "amazon_refresh_orders" }] : undefined,
        threadStatus: "idle",
        pendingRequestId: null,
        lastError: null,
        idempotencyKey: `msg_receipt_${latestRequest.order.orderId}`,
      });
    }

    return {
      outcome: decisionRes.outcome,
      request: latestRequest,
    };
  },
});
