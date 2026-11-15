import { ConvexError, v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { requireShopper } from "./lib/auth";
import { actor, quote } from "./lib/validators";
import { clientQuote } from "./lib/clientPayloads";
import {
  QUOTE_TTL_MS,
  createRequestFor,
  decideFor,
  listPendingFor,
  listPurchasesFor,
  loadOwnedRequest,
  requestPurchaseFor,
  requestView,
} from "./model/purchases";
import { getAdapter } from "./retail";
import type { OfferSnapshot } from "./retail/adapter";

export const requestPurchaseArgs = {
  itemId: v.id("cartItems"),
  offerId: v.id("offers"),
  quantity: v.number(),
  reason: v.string(),
  idempotencyKey: v.string(),
};

export const requestPurchase = action({
  args: requestPurchaseArgs,
  handler: async (ctx, args) => requestPurchaseFor(ctx, await requireShopper(ctx), args, "app"),
});

/**
 * Patches a pending request with the quote the shopper's own device scraped from
 * the live retailer page (the WKWebView Amazon engine). The client never decides
 * which request it owns: ownership comes from the session.
 */
export const attachClientQuote = mutation({
  args: { requestId: v.id("purchaseRequests"), quoteVersion: v.number(), quote: clientQuote },
  returns: v.object({ quoteVersion: v.number(), quote }),
  handler: async (ctx, { requestId, quoteVersion, quote: incoming }) => {
    const shopperId = await requireShopper(ctx);
    const req = await loadOwnedRequest(ctx, shopperId, requestId);
    if (req.status !== "quoting" && req.status !== "pending_approval") {
      throw new ConvexError({ code: "INVALID_STATE", message: "This request is no longer awaiting a quote." });
    }
    if (req.quoteVersion !== quoteVersion) {
      throw new ConvexError({ code: "STALE_QUOTE", message: "A newer quote already exists for this request." });
    }
    const cents = [
      incoming.unitPriceCents,
      incoming.subtotalCents,
      incoming.taxCents,
      incoming.shippingCents,
      incoming.totalCents,
      incoming.quantity,
    ];
    if (cents.some((n) => !Number.isInteger(n) || n < 0)) {
      throw new ConvexError({ code: "INVALID_QUOTE", message: "Quote amounts must be non-negative integer cents." });
    }
    const stored = {
      ...incoming,
      variantLabel: incoming.variantLabel ?? "Default",
      imageUrl: incoming.imageUrl ?? undefined,
      quotedAt: incoming.quotedAt || Date.now(),
    };
    const nextVersion = req.quoteVersion + 1;
    const expiresAt = Date.now() + QUOTE_TTL_MS;
    await ctx.db.patch("purchaseRequests", requestId, {
      quote: stored,
      quoteVersion: nextVersion,
      status: "pending_approval",
      expiresAt,
    });
    // The original expiry job now fires before this new deadline.
    await ctx.scheduler.runAt(expiresAt + 1000, internal.purchases.expire, { requestId });
    return { quoteVersion: nextVersion, quote: stored };
  },
});

export const listPendingApprovals = query({
  args: {},
  handler: async (ctx) => listPendingFor(ctx, await requireShopper(ctx)),
});

export const decidePurchase = mutation({
  returns: v.object({
    outcome: v.union(
      v.literal("approved"),
      v.literal("already_approved"),
      v.literal("deferred"),
      v.literal("stale_quote"),
      v.literal("expired"),
      v.literal("invalid_state"),
    ),
    request: v.any(),
  }),
  args: {
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    decision: v.union(v.literal("approve"), v.literal("defer")),
  },
  handler: async (ctx, args) => decideFor(ctx, await requireShopper(ctx), args),
});

export const getPurchaseStatus = query({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) =>
    requestView(ctx, await loadOwnedRequest(ctx, await requireShopper(ctx), requestId)),
});

export const listPurchases = query({
  args: {},
  handler: async (ctx) => listPurchasesFor(ctx, await requireShopper(ctx)),
});

// ---- internal plumbing ----

export const createRequest = internalMutation({
  args: { shopperId: v.id("users"), requestedBy: actor, ...requestPurchaseArgs },
  handler: async (ctx, { shopperId, requestedBy, ...args }) =>
    createRequestFor(ctx, shopperId, args, requestedBy),
});

export const getRequestInternal = internalQuery({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => await ctx.db.get("purchaseRequests", requestId),
});

export const offerSnapshot = internalQuery({
  args: { offerId: v.id("offers") },
  handler: async (ctx, { offerId }): Promise<OfferSnapshot | null> => {
    const offer = await ctx.db.get("offers", offerId);
    if (!offer) return null;
    const product = await ctx.db.get("products", offer.productId);
    const variant = await ctx.db.get("variants", offer.variantId);
    return {
      offerId: offer._id,
      retailer: offer.retailer,
      retailerName: offer.retailerName,
      seller: offer.seller,
      url: offer.url,
      canonicalKey: offer.canonicalKey,
      productTitle: product?.title ?? "Unknown product",
      variantLabel: variant?.label ?? "Default",
      imageUrl: product?.imageUrl,
      priceCents: offer.priceCents,
      shippingCents: offer.shippingCents,
      currency: offer.currency,
      deliveryEstimate: offer.deliveryEstimate,
      returnSummary: offer.returnSummary,
      inStock: offer.inStock,
    };
  },
});

export const resolveQuote = internalAction({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.runQuery(internal.purchases.getRequestInternal, { requestId });
    if (!req || req.status !== "quoting") return null;
    const offer = await ctx.runQuery(internal.purchases.offerSnapshot, { offerId: req.offerId });
    if (!offer) {
      await ctx.runMutation(internal.purchases.failRequest, { requestId, error: "Offer no longer exists." });
      return null;
    }
    const fresh = await getAdapter(ctx, offer.retailer).getQuote({ offer, quantity: req.quantity });
    await ctx.runMutation(internal.purchases.setQuote, { requestId, quote: fresh, onlyWhileQuoting: true });
    return null;
  },
});

export const setQuote = internalMutation({
  args: { requestId: v.id("purchaseRequests"), quote, onlyWhileQuoting: v.boolean() },
  handler: async (ctx, { requestId, quote, onlyWhileQuoting }) => {
    const req = await ctx.db.get("purchaseRequests", requestId);
    if (!req) return null;
    if (onlyWhileQuoting ? req.status !== "quoting" : req.status !== "approved") return null;
    const expiresAt = Date.now() + QUOTE_TTL_MS;
    await ctx.db.patch("purchaseRequests", requestId, {
      status: "pending_approval",
      quote,
      quoteVersion: req.quoteVersion + 1,
      expiresAt,
      decidedAt: undefined,
    });
    await ctx.scheduler.runAt(expiresAt + 1000, internal.purchases.expire, { requestId });
    return null;
  },
});

export const expire = internalMutation({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => {
    const req = await ctx.db.get("purchaseRequests", requestId);
    if (req && req.status === "pending_approval" && Date.now() > req.expiresAt) {
      await ctx.db.patch("purchaseRequests", requestId, { status: "expired" });
    }
    return null;
  },
});

export const failRequest = internalMutation({
  args: { requestId: v.id("purchaseRequests"), error: v.string() },
  handler: async (ctx, { requestId, error }) => {
    await ctx.db.patch("purchaseRequests", requestId, { status: "failed", error });
    return null;
  },
});
