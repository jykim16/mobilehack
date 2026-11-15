import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { notFound } from "../lib/auth";
import type { Quote } from "../lib/validators";

export const QUOTE_TTL_MS = 30 * 60_000;

export type RequestPurchaseArgs = {
  itemId: Id<"cartItems">;
  offerId: Id<"offers">;
  quantity: number;
  reason: string;
  idempotencyKey: string;
};

export async function createRequestFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  args: RequestPurchaseArgs,
  requestedBy: "app" | "agent",
): Promise<Id<"purchaseRequests">> {
  const existing = await ctx.db
    .query("purchaseRequests")
    .withIndex("by_shopperId_and_idempotencyKey", (q) =>
      q.eq("shopperId", shopperId).eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) return existing._id;

  const item = await ctx.db.get("cartItems", args.itemId);
  if (!item || item.shopperId !== shopperId || item.status === "removed") notFound("Cart item");
  if (item.status !== "active") {
    throw new ConvexError({ code: "INVALID_STATE", message: "Item was already purchased." });
  }
  const offer = await ctx.db.get("offers", args.offerId);
  if (!offer || offer.productId !== item.productId) {
    throw new ConvexError({ code: "OFFER_MISMATCH", message: "offerId is not an offer for this item." });
  }
  if (!offer.inStock || offer.priceCents <= 0) {
    throw new ConvexError({
      code: "OFFER_UNAVAILABLE",
      message: "This offer has no purchasable price right now.",
    });
  }
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 10) {
    throw new ConvexError({ code: "INVALID_QUANTITY", message: "quantity must be 1-10." });
  }
  const requestId = await ctx.db.insert("purchaseRequests", {
    shopperId,
    cartItemId: item._id,
    offerId: offer._id,
    quantity: args.quantity,
    reason: args.reason,
    requestedBy,
    idempotencyKey: args.idempotencyKey,
    status: "quoting",
    quoteVersion: 0,
    expiresAt: Date.now() + QUOTE_TTL_MS,
  });
  await ctx.scheduler.runAfter(10_000, internal.purchases.resolveQuote, { requestId });
  return requestId;
}

/** Shared body of the public and internal requestPurchase actions. */
export async function requestPurchaseFor(
  ctx: ActionCtx,
  shopperId: Id<"users">,
  args: RequestPurchaseArgs,
  requestedBy: "app" | "agent",
): Promise<{ requestId: Id<"purchaseRequests">; status: string; quoteVersion: number; expiresAt: number; quote: Quote | null }> {
  const requestId: Id<"purchaseRequests"> = await ctx.runMutation(internal.purchases.createRequest, {
    shopperId,
    requestedBy,
    ...args,
  });
  await ctx.runAction(internal.purchases.resolveQuote, { requestId });
  const req = await ctx.runQuery(internal.purchases.getRequestInternal, { requestId });
  if (!req) throw new ConvexError({ code: "NOT_FOUND", message: "Purchase request not found." });
  return {
    requestId,
    status: req.status,
    quoteVersion: req.quoteVersion,
    expiresAt: req.expiresAt,
    quote: req.quote ?? null,
  };
}

/** Status as persisted; expiry is written by the scheduled `purchases.expire` mutation. */
export async function requestView(ctx: QueryCtx, req: Doc<"purchaseRequests">) {
  const order = await ctx.db
    .query("orders")
    .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", req._id))
    .unique();
  const shipment = order
    ? await ctx.db
        .query("shipments")
        .withIndex("by_orderId", (q) => q.eq("orderId", order._id))
        .unique()
    : null;
  return {
    requestId: req._id,
    itemId: req.cartItemId,
    offerId: req.offerId,
    status: req.status,
    requestedBy: req.requestedBy,
    reason: req.reason,
    quantity: req.quantity,
    quoteVersion: req.quoteVersion,
    quote: req.quote ?? null,
    expiresAt: req.expiresAt,
    decidedAt: req.decidedAt ?? null,
    requestedAt: req._creationTime,
    error: req.error ?? null,
    order: order
      ? {
          orderId: order._id,
          orderRef: order.orderRef,
          status: order.status,
          retailerOrderId: order.retailerOrderId ?? null,
          placedAt: order.placedAt ?? null,
          simulated: order.simulated,
        }
      : null,
    shipment: shipment
      ? {
          status: shipment.status,
          carrier: shipment.carrier ?? null,
          trackingNumber: shipment.trackingNumber ?? null,
          trackingUrl: shipment.trackingUrl ?? null,
          eta: shipment.eta ?? null,
          events: shipment.events ?? [],
          updatedAt: shipment.updatedAt,
          simulated: shipment.simulated,
        }
      : null,
  };
}

export async function loadOwnedRequest(ctx: QueryCtx, shopperId: Id<"users">, requestId: Id<"purchaseRequests">) {
  const req = await ctx.db.get("purchaseRequests", requestId);
  if (!req || req.shopperId !== shopperId) notFound("Purchase request");
  return req;
}

export async function listPendingFor(ctx: QueryCtx, shopperId: Id<"users">) {
  const reqs = await ctx.db
    .query("purchaseRequests")
    .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", "pending_approval"))
    .order("desc")
    .take(50);
  return await Promise.all(
    reqs.map(async (r) => {
      const view = await requestView(ctx, r);
      const item = await ctx.db.get("cartItems", r.cartItemId);
      return { ...view, decision: item?.decision ?? null };
    }),
  );
}

export type DecideOutcome =
  | "approved"
  | "already_approved"
  | "deferred"
  | "stale_quote"
  | "expired"
  | "invalid_state";

export function orderRefFor(requestId: Id<"purchaseRequests">) {
  return `CART-${requestId.slice(-10).toUpperCase()}`;
}

export async function decideFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  args: { requestId: Id<"purchaseRequests">; quoteVersion: number; decision: "approve" | "defer" },
) {
  const req = await loadOwnedRequest(ctx, shopperId, args.requestId);
  const now = Date.now();
  const result = async (outcome: DecideOutcome) => {
    const fresh = (await ctx.db.get("purchaseRequests", req._id))!;
    return { outcome, request: await requestView(ctx, fresh) };
  };

  if (args.decision === "defer") {
    if (req.status === "deferred") return await result("deferred");
    if (req.status !== "pending_approval" && req.status !== "quoting") return await result("invalid_state");
    await ctx.db.patch("purchaseRequests", req._id, { status: "deferred", decidedAt: now });
    return await result("deferred");
  }

  if (req.status === "approved" || req.status === "ordered") {
    return await result(args.quoteVersion === req.quoteVersion ? "already_approved" : "stale_quote");
  }
  if (req.status !== "pending_approval" || !req.quote) return await result("invalid_state");
  if (args.quoteVersion !== req.quoteVersion) return await result("stale_quote");
  const item = await ctx.db.get("cartItems", req.cartItemId);
  if (!item || item.status !== "active") {
    await ctx.db.patch("purchaseRequests", req._id, {
      status: "failed",
      error: "This item is no longer in the cart.",
    });
    return await result("invalid_state");
  }
  if (now > req.expiresAt) {
    await ctx.db.patch("purchaseRequests", req._id, { status: "expired" });
    return await result("expired");
  }

  const competing = await ctx.db
    .query("purchaseRequests")
    .withIndex("by_shopperId_and_status", (q) =>
      q.eq("shopperId", shopperId).eq("status", "pending_approval"),
    )
    .take(50);
  for (const other of competing) {
    if (other._id !== req._id && other.cartItemId === req.cartItemId) {
      await ctx.db.patch("purchaseRequests", other._id, {
        status: "expired",
        error: "Another purchase request for this item was approved.",
      });
    }
  }
  await ctx.db.patch("purchaseRequests", req._id, { status: "approved", decidedAt: now });
  const existingOrder = await ctx.db
    .query("orders")
    .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", req._id))
    .unique();
  let orderId: Id<"orders">;
  if (existingOrder) {
    if (existingOrder.status === "placed" || existingOrder.status === "submitting" || existingOrder.status === "unknown") {
      return await result("already_approved");
    }
    orderId = existingOrder._id;
    await ctx.db.patch("orders", orderId, {
      status: "submitting",
      quote: req.quote,
      quoteVersion: req.quoteVersion,
      error: undefined,
    });
  } else {
    const offer = await ctx.db.get("offers", req.offerId);
    orderId = await ctx.db.insert("orders", {
      shopperId,
      purchaseRequestId: req._id,
      cartItemId: req.cartItemId,
      orderRef: orderRefFor(req._id),
      retailer: offer?.retailer ?? req.quote.retailer,
      status: "submitting",
      quoteVersion: req.quoteVersion,
      quote: req.quote,
      submitAttempts: 0,
      simulated: req.quote.simulated,
    });
  }
  await ctx.scheduler.runAfter(0, internal.orders.submitOrder, { orderId });
  return await result("approved");
}

export async function listPurchasesFor(ctx: QueryCtx, shopperId: Id<"users">) {
  const orders = await ctx.db
    .query("orders")
    .withIndex("by_shopperId", (q) => q.eq("shopperId", shopperId))
    .order("desc")
    .take(50);
  return await Promise.all(
    orders
      .filter((o) => o.status === "placed" || o.status === "submitting" || o.status === "unknown")
      .map(async (o) => {
        const shipment = await ctx.db
          .query("shipments")
          .withIndex("by_orderId", (q) => q.eq("orderId", o._id))
          .unique();
        return {
          orderId: o._id,
          orderRef: o.orderRef,
          requestId: o.purchaseRequestId,
          itemId: o.cartItemId,
          status: o.status,
          retailerOrderId: o.retailerOrderId ?? null,
          placedAt: o.placedAt ?? null,
          quote: o.quote,
          simulated: o.simulated,
          shipment: shipment
            ? {
                status: shipment.status,
                carrier: shipment.carrier ?? null,
                trackingNumber: shipment.trackingNumber ?? null,
                trackingUrl: shipment.trackingUrl ?? null,
                eta: shipment.eta ?? null,
                events: shipment.events ?? [],
                updatedAt: shipment.updatedAt,
                simulated: shipment.simulated,
              }
            : null,
        };
      }),
  );
}
