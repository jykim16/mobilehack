import { ConvexError, v, type Infer } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { requireShopper } from "./lib/auth";
import { internal } from "./_generated/api";
import { enrichmentStatus as enrichmentStatusValidator, targetAppliesTo } from "./lib/validators";

type EnrichmentStatus = Infer<typeof enrichmentStatusValidator>;
type Candidate = { title: string; url: string; retailer: string; priceCents: number | null };
import {
  addItemFor,
  getItemFor,
  listItemsFor,
  removeItemFor,
  setQuantityFor,
  updateDecisionFor,
} from "./model/cart";

export const addItem = mutation({
  args: {
    url: v.string(),
    variant: v.optional(v.string()),
    reason: v.optional(v.string()),
    quantity: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => addItemFor(ctx, await requireShopper(ctx), args, "app"),
});

export const listItems = query({
  args: {},
  handler: async (ctx) => listItemsFor(ctx, await requireShopper(ctx)),
});

export const getItem = query({
  args: { itemId: v.id("cartItems") },
  handler: async (ctx, { itemId }) => getItemFor(ctx, await requireShopper(ctx), itemId),
});

export const updateDecision = mutation({
  returns: v.object({
    priorities: v.array(v.string()),
    targetCents: v.optional(v.number()),
    targetAppliesTo: v.optional(targetAppliesTo),
    updatedAt: v.number(),
  }),
  args: {
    itemId: v.id("cartItems"),
    priorities: v.array(v.string()),
    targetCents: v.optional(v.number()),
    targetAppliesTo: v.optional(targetAppliesTo),
  },
  handler: async (ctx, args) => updateDecisionFor(ctx, await requireShopper(ctx), args),
});

export const setQuantity = mutation({
  returns: v.null(),
  args: { itemId: v.id("cartItems"), quantity: v.number() },
  handler: async (ctx, { itemId, quantity }) => setQuantityFor(ctx, await requireShopper(ctx), itemId, quantity),
});

export const removeItem = mutation({
  returns: v.object({ removed: v.boolean(), title: v.string() }),
  args: {
    cartItemId: v.optional(v.id("cartItems")),
    itemId: v.optional(v.id("cartItems")),
  },
  handler: async (ctx, args) => {
    const cartItemId = args.cartItemId ?? args.itemId;
    if (!cartItemId) {
      throw new ConvexError({ code: "INVALID_ARGUMENT", message: "cartItemId is required." });
    }
    return await removeItemFor(ctx, await requireShopper(ctx), cartItemId);
  },
});

type AddFromQueryResult = {
  itemId: Id<"cartItems">;
  enrichmentStatus: EnrichmentStatus;
  resolvedUrl: string;
  resolvedTitle: string;
  alternatives: Candidate[];
};

const resolvedCandidate = v.object({
  title: v.string(),
  url: v.string(),
  retailer: v.string(),
  priceCents: v.union(v.number(), v.null()),
});

/**
 * The cart's "add a product by name" path: Exa resolves the words to a product
 * URL, and that URL goes through addItem, so enrichment, evidence, comparison and
 * provenance are identical to a pasted link.
 */
export const addItemFromQuery = action({
  returns: v.object({
    itemId: v.id("cartItems"),
    enrichmentStatus: enrichmentStatusValidator,
    resolvedUrl: v.string(),
    resolvedTitle: v.string(),
    alternatives: v.array(resolvedCandidate),
  }),
  args: {
    query: v.string(),
    idempotencyKey: v.string(),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, { query, idempotencyKey, reason }): Promise<AddFromQueryResult> => {
    const shopperId = await requireShopper(ctx);
    const existing: { itemId: Id<"cartItems">; enrichmentStatus: EnrichmentStatus; url: string; title: string } | null =
      await ctx.runQuery(internal.cart.findByKey, { shopperId, idempotencyKey });
    if (existing) {
      return {
        itemId: existing.itemId,
        enrichmentStatus: existing.enrichmentStatus,
        resolvedUrl: existing.url,
        resolvedTitle: existing.title,
        alternatives: [],
      };
    }
    const words = query.trim();
    if (!words) {
      throw new ConvexError({ code: "NO_MATCH", message: "Type a product name or a link." });
    }
    const resolved: { ok: boolean; error: string | null; candidates: Candidate[] } = await ctx.runAction(
      internal.exa.resolveProductQuery,
      { query: words },
    );
    if (!resolved.ok || resolved.candidates.length === 0) {
      throw new ConvexError({
        code: "NO_MATCH",
        message: `Couldn't find a product for "${words}". Try a more specific name or paste the link.`,
      });
    }
    const top: Candidate = resolved.candidates[0];
    const added: { itemId: Id<"cartItems">; enrichmentStatus: EnrichmentStatus; deduplicated: boolean } =
      await ctx.runMutation(internal.cart.addForShopper, {
        shopperId,
        url: top.url,
        idempotencyKey,
        reason,
      });
    return {
      itemId: added.itemId,
      enrichmentStatus: added.enrichmentStatus,
      resolvedUrl: top.url,
      resolvedTitle: top.title,
      alternatives: resolved.candidates.slice(1, 4),
    };
  },
});

export const findByKey = internalQuery({
  args: { shopperId: v.id("users"), idempotencyKey: v.string() },
  handler: async (ctx, { shopperId, idempotencyKey }) => {
    const item = await ctx.db
      .query("cartItems")
      .withIndex("by_shopperId_and_idempotencyKey", (q) =>
        q.eq("shopperId", shopperId).eq("idempotencyKey", idempotencyKey),
      )
      .unique();
    if (!item || item.status === "removed") return null;
    const product = item.productId ? await ctx.db.get("products", item.productId) : null;
    return {
      itemId: item._id,
      enrichmentStatus: item.enrichmentStatus,
      url: item.url,
      title: product?.title ?? item.url,
    };
  },
});

export const addForShopper = internalMutation({
  args: {
    shopperId: v.id("users"),
    url: v.string(),
    reason: v.optional(v.string()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, { shopperId, ...args }) => addItemFor(ctx, shopperId, args, "app"),
});
