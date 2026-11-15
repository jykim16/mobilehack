import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { getAdapter } from "./retail";
import { materialTermsChanged } from "./retail/adapter";
import { quote, shipmentStatus } from "./lib/validators";

const MAX_SUBMIT_ATTEMPTS = 5;
const SHIPMENT_POLL_MS = 10_000;

export const getOrderInternal = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get("orders", orderId);
    if (!order) return null;
    const request = await ctx.db.get("purchaseRequests", order.purchaseRequestId);
    return { order, request };
  },
});

/**
 * Submits an approved order exactly once:
 * 1. reconcile with the retailer by orderRef if an earlier attempt may have landed,
 * 2. re-quote and send the request back for approval if material terms changed,
 * 3. record the attempt, then place the order (adapter is idempotent on orderRef).
 */
export const submitOrder = internalAction({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const loaded = await ctx.runQuery(internal.orders.getOrderInternal, { orderId });
    if (!loaded || !loaded.request) return null;
    const { order, request } = loaded;
    if (order.status !== "submitting" && order.status !== "unknown") return null;

    const offer = await ctx.runQuery(internal.purchases.offerSnapshot, { offerId: request.offerId });
    if (!offer) {
      await ctx.runMutation(internal.orders.markFailed, { orderId, error: "Offer no longer exists." });
      return null;
    }
    const adapter = getAdapter(ctx, order.retailer);

    if (order.submitAttempts > 0) {
      const existing = await adapter.getOrderStatus({ orderRef: order.orderRef });
      if (existing.status === "placed") {
        await ctx.runMutation(internal.orders.markPlaced, {
          orderId,
          retailerOrderId: existing.retailerOrderId,
          placedAt: existing.placedAt,
        });
        return null;
      }
    }

    const fresh = await adapter.getQuote({ offer, quantity: request.quantity });
    const changed = materialTermsChanged(order.quote, fresh);
    if (changed.length > 0) {
      await ctx.runMutation(internal.orders.markRequote, { orderId, quote: fresh, changed });
      return null;
    }

    const attempt = await ctx.runMutation(internal.orders.recordAttempt, { orderId });
    if (attempt > MAX_SUBMIT_ATTEMPTS) {
      await ctx.runMutation(internal.orders.markFailed, { orderId, error: "Too many submit attempts." });
      return null;
    }
    try {
      const res = await adapter.placeOrder({ orderRef: order.orderRef, offer, quote: order.quote });
      if (res.status === "placed") {
        await ctx.runMutation(internal.orders.markPlaced, {
          orderId,
          retailerOrderId: res.retailerOrderId,
          placedAt: res.placedAt,
        });
      } else if (res.status === "rejected") {
        await ctx.runMutation(internal.orders.markFailed, { orderId, error: res.reason });
      } else {
        await ctx.runMutation(internal.orders.markUnknown, { orderId });
        await ctx.scheduler.runAfter(5_000 * attempt, internal.orders.submitOrder, { orderId });
      }
    } catch (e) {
      await ctx.runMutation(internal.orders.markUnknown, { orderId });
      await ctx.scheduler.runAfter(5_000 * attempt, internal.orders.submitOrder, { orderId });
      console.error("placeOrder failed; will reconcile before retry", order.orderRef, String(e));
    }
    return null;
  },
});

export const recordAttempt = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = (await ctx.db.get("orders", orderId))!;
    const submitAttempts = order.submitAttempts + 1;
    await ctx.db.patch("orders", orderId, { submitAttempts });
    return submitAttempts;
  },
});

export const markUnknown = internalMutation({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    await ctx.db.patch("orders", orderId, { status: "unknown" });
    return null;
  },
});

export const markPlaced = internalMutation({
  args: { orderId: v.id("orders"), retailerOrderId: v.string(), placedAt: v.number() },
  handler: async (ctx, { orderId, retailerOrderId, placedAt }) => {
    const order = await ctx.db.get("orders", orderId);
    if (!order || order.status === "placed") return null;
    await ctx.db.patch("orders", orderId, { status: "placed", retailerOrderId, placedAt, error: undefined });
    await ctx.db.patch("purchaseRequests", order.purchaseRequestId, { status: "ordered" });
    await ctx.db.patch("cartItems", order.cartItemId, { status: "purchased" });
    const existing = await ctx.db
      .query("shipments")
      .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
      .unique();
    if (!existing) {
      await ctx.db.insert("shipments", {
        shopperId: order.shopperId,
        orderId,
        status: "ordered",
        updatedAt: Date.now(),
        simulated: order.simulated,
      });
    }
    await ctx.scheduler.runAfter(SHIPMENT_POLL_MS, internal.orders.syncShipment, { orderId, polls: 0 });
    return null;
  },
});

export const markRequote = internalMutation({
  args: { orderId: v.id("orders"), quote, changed: v.array(v.string()) },
  handler: async (ctx, { orderId, quote, changed }) => {
    const order = await ctx.db.get("orders", orderId);
    if (!order) return null;
    await ctx.db.patch("orders", orderId, {
      status: "requote_required",
      error: `Material terms changed: ${changed.join(", ")}`,
    });
    await ctx.runMutation(internal.purchases.setQuote, {
      requestId: order.purchaseRequestId,
      quote,
      expectStatus: "approved",
    });
    return null;
  },
});

export const markFailed = internalMutation({
  args: { orderId: v.id("orders"), error: v.string() },
  handler: async (ctx, { orderId, error }) => {
    const order = await ctx.db.get("orders", orderId);
    if (!order) return null;
    await ctx.db.patch("orders", orderId, { status: "failed", error });
    await ctx.db.patch("purchaseRequests", order.purchaseRequestId, { status: "failed", error });
    return null;
  },
});

export const syncShipment = internalAction({
  args: { orderId: v.id("orders"), polls: v.number() },
  handler: async (ctx, { orderId, polls }) => {
    const loaded = await ctx.runQuery(internal.orders.getOrderInternal, { orderId });
    if (!loaded || loaded.order.status !== "placed") return null;
    const status = await getAdapter(ctx, loaded.order.retailer).getOrderStatus({
      orderRef: loaded.order.orderRef,
    });
    if (status.status !== "placed") return null;
    await ctx.runMutation(internal.orders.applyShipment, { orderId, ...status.shipment });
    const done = status.shipment.status === "delivered" || status.shipment.status === "shipped";
    if (!done && polls < 60) {
      await ctx.scheduler.runAfter(SHIPMENT_POLL_MS, internal.orders.syncShipment, { orderId, polls: polls + 1 });
    }
    return null;
  },
});

export const applyShipment = internalMutation({
  args: {
    orderId: v.id("orders"),
    status: shipmentStatus,
    carrier: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    trackingUrl: v.optional(v.string()),
    eta: v.optional(v.string()),
  },
  handler: async (ctx, { orderId, ...fields }) => {
    const shipment = await ctx.db
      .query("shipments")
      .withIndex("by_orderId", (q) => q.eq("orderId", orderId))
      .unique();
    if (!shipment) return null;
    await ctx.db.patch("shipments", shipment._id, { ...fields, updatedAt: Date.now() });
    return null;
  },
});
