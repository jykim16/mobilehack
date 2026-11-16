import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  createPendingPayment,
  ledgerBalanceCents,
  markEventProcessed,
  pendingPaymentFor,
  recordCharge,
  recordEventOnce,
  recordPaid,
  recordSubaccountFor,
  subaccountFor,
} from "./model/whop";
import {
  chargeCard,
  createCheckoutConfiguration,
  createSubaccount,
  issueCard,
  refundPayment,
  whopConfig,
  whopEnvironment,
} from "./lib/whop";

const subaccountStatus = v.union(
  v.literal("pending_kyc"),
  v.literal("active"),
  v.literal("restricted"),
  v.literal("failed"),
);

export const subaccount = internalQuery({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => await subaccountFor(ctx, shopperId),
});

export const pendingPayment = internalQuery({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => await pendingPaymentFor(ctx, requestId),
});

export const ledger = internalQuery({
  args: { subaccountId: v.id("shopperSubaccounts") },
  handler: async (ctx, { subaccountId }) => await ledgerBalanceCents(ctx, subaccountId),
});

export const saveSubaccount = internalMutation({
  args: {
    shopperId: v.id("users"),
    providerAccountId: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    kycRequired: v.boolean(),
    status: subaccountStatus,
  },
  handler: async (ctx, args) => await recordSubaccountFor(ctx, args),
});

export const savePayment = internalMutation({
  args: {
    shopperId: v.id("users"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    subaccountId: v.id("shopperSubaccounts"),
    checkoutConfigId: v.union(v.string(), v.null()),
    checkoutUrl: v.union(v.string(), v.null()),
    amountCents: v.number(),
    currency: v.string(),
  },
  handler: async (ctx, args) => await createPendingPayment(ctx, args),
});

export const saveEvent = internalMutation({
  args: {
    providerEventId: v.string(),
    type: v.string(),
    signatureVerified: v.boolean(),
    payloadDigest: v.string(),
  },
  handler: async (ctx, args) => await recordEventOnce(ctx, args),
});

export const finishEvent = internalMutation({
  args: { eventId: v.id("whopWebhookEvents"), outcome: v.string() },
  handler: async (ctx, { eventId, outcome }) => await markEventProcessed(ctx, eventId, outcome),
});

export const savePaid = internalMutation({
  args: {
    providerPaymentId: v.string(),
    requestId: v.union(v.string(), v.null()),
    quoteVersion: v.union(v.string(), v.null()),
    amountCents: v.union(v.number(), v.null()),
    currency: v.union(v.string(), v.null()),
    paidAt: v.number(),
  },
  handler: async (ctx, args) => await recordPaid(ctx, args),
});

export const saveCharge = internalMutation({
  args: {
    shopperId: v.id("users"),
    subaccountId: v.id("shopperSubaccounts"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    orderId: v.id("orders"),
    cardId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    providerTransactionId: v.union(v.string(), v.null()),
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
    merchantName: v.string(),
    orderReference: v.string(),
    unknown: v.boolean(),
  },
  handler: async (ctx, args) => await recordCharge(ctx, args),
});

export const setSubaccount = internalMutation({
  args: {
    subaccountId: v.id("shopperSubaccounts"),
    cardId: v.optional(v.string()),
    cardLast4: v.optional(v.string()),
    cardStatus: v.optional(
      v.union(
        v.literal("none"),
        v.literal("requested"),
        v.literal("active"),
        v.literal("blocked"),
        v.literal("unsupported"),
      ),
    ),
    cardSpendLimitCents: v.optional(v.number()),
    cardTransactionLimitCents: v.optional(v.number()),
    cardNote: v.optional(v.string()),
    availableBalanceCents: v.optional(v.number()),
    balanceCheckedAt: v.optional(v.number()),
  },
  handler: async (ctx, { subaccountId, ...patch }) => {
    await ctx.db.patch("shopperSubaccounts", subaccountId, {
      ...patch,
      cardIssuedAt: patch.cardId ? Date.now() : undefined,
      updatedAt: Date.now(),
    });
  },
});

export const setOrder = internalMutation({
  args: {
    orderId: v.id("orders"),
    status: v.optional(
      v.union(
        v.literal("awaiting_payment"),
        v.literal("submitting"),
        v.literal("awaiting_client"),
        v.literal("placed"),
        v.literal("unknown"),
        v.literal("requote_required"),
        v.literal("failed"),
      ),
    ),
    error: v.optional(v.union(v.string(), v.null())),
    revalidation: v.optional(
      v.object({
        status: v.union(v.literal("unchanged"), v.literal("changed"), v.literal("unavailable")),
        checkedAt: v.number(),
        totalCents: v.union(v.number(), v.null()),
        note: v.union(v.string(), v.null()),
      }),
    ),
    revalidatedAt: v.optional(v.number()),
    refundedAt: v.optional(v.number()),
  },
  handler: async (ctx, { orderId, error, ...patch }) => {
    await ctx.db.patch("orders", orderId, { ...patch, error: error ?? undefined });
  },
});

export const requestBilling = internalQuery({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => {
    const request = await ctx.db.get("purchaseRequests", requestId);
    if (!request) return null;
    const order = await ctx.db
      .query("orders")
      .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", requestId))
      .unique();
    const offer = await ctx.db.get("offers", request.offerId);
    const payment = await pendingPaymentFor(ctx, requestId);
    return { request, order, offer, payment };
  },
});

/** Recent deliveries and payments, so the trail can be read without a dashboard. */
export const webhookTrail = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const take = limit ?? 10;
    const events = await ctx.db.query("whopWebhookEvents").withIndex("by_providerEventId").take(take);
    const payments = await ctx.db.query("payments").take(take);
    const charges = await ctx.db.query("cardTransactions").take(take);
    return {
      events: events
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .map((e) => ({
          id: e._id,
          eventId: e.providerEventId,
          type: e.type,
          receivedAt: e.receivedAt,
          signatureVerified: e.signatureVerified,
          processedAt: e.processedAt ?? null,
          outcome: e.outcome ?? null,
        })),
      payments: payments
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((p) => ({
          id: p._id,
          providerPaymentId: p.providerPaymentId ?? null,
          status: p.status,
          amountCents: p.amountCents,
          currency: p.currency,
          quoteVersion: p.quoteVersion,
          paidAt: p.paidAt ?? null,
          failureReason: p.failureReason ?? null,
          checkoutUrl: p.checkoutUrl ?? null,
        })),
      charges: charges.map((c) => ({
        id: c._id,
        status: c.status,
        amountCents: c.amountCents,
        providerTransactionId: c.providerTransactionId ?? null,
        unknownCharge: c.unknownCharge,
        note: c.note ?? null,
      })),
    };
  },
});

/** Creates the shopper's subaccount the first time they need one. */
export const ensureSubaccount = internalAction({
  args: { shopperId: v.id("users"), email: v.optional(v.string()), name: v.optional(v.string()) },
  handler: async (ctx, { shopperId, email, name }): Promise<Id<"shopperSubaccounts">> => {
    const existing: { _id: Id<"shopperSubaccounts"> } | null = await ctx.runQuery(internal.whop.subaccount, {
      shopperId,
    });
    if (existing) return existing._id;
    const config = whopConfig();
    if (!config) throw new Error("WHOP_API_KEY or WHOP_ACCOUNT_ID is not set");
    const created = await createSubaccount(config, {
      title: (name ?? "Cart shopper").slice(0, 80),
      email: email ?? `${shopperId}@cart.local`,
    });
    if (!created.ok) throw new Error(created.error);
    const subaccountId: Id<"shopperSubaccounts"> = await ctx.runMutation(internal.whop.saveSubaccount, {
      shopperId,
      providerAccountId: created.data.id,
      environment: whopEnvironment(config.base),
      // Sandbox subaccounts are created without onboarding; production needs KYC.
      kycRequired: whopEnvironment(config.base) === "production",
      status: "active",
    });
    return subaccountId;
  },
});

/** Money in: a one-time checkout against the shopper's own subaccount. */
export const fundPurchase = internalAction({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => {
    const billing = await ctx.runQuery(internal.whop.requestBilling, { requestId });
    if (!billing || !billing.request.quote || !billing.order) return null;
    if (billing.payment?.status === "succeeded") return null;
    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    const subaccountId = await ctx.runAction(internal.whop.ensureSubaccount, {
      shopperId: billing.request.shopperId,
    });
    const subaccount = await ctx.runQuery(internal.whop.subaccount, {
      shopperId: billing.request.shopperId,
    });
    if (!subaccount) throw new Error("Subaccount vanished after creation");
    const checkout = await createCheckoutConfiguration(config, {
      subaccountId: subaccount.providerAccountId,
      amountCents: billing.request.quote.totalCents,
      currency: billing.request.quote.currency ?? "USD",
      title: billing.offer?.seller ? `Cart order: ${billing.offer.seller}` : "Cart order",
      requestId,
      quoteVersion: billing.request.quoteVersion,
    });
    if (!checkout.ok) {
      await ctx.runMutation(internal.whop.setOrder, {
        orderId: billing.order._id,
        status: "awaiting_payment",
        error: `Could not open a Whop checkout: ${checkout.error}`,
      });
      return null;
    }
    await ctx.runMutation(internal.whop.savePayment, {
      shopperId: billing.request.shopperId,
      requestId,
      quoteVersion: billing.request.quoteVersion,
      subaccountId,
      checkoutConfigId: checkout.data.id,
      checkoutUrl: checkout.data.purchase_url ?? null,
      amountCents: billing.request.quote.totalCents,
      currency: (billing.request.quote.currency ?? "USD").toUpperCase(),
    });
    return null;
  },
});

/**
 * A verified payment event. Records the payment once, then hands fulfilment its own
 * step so the webhook answers inside Whop's five-second window.
 */
export const handlePaymentEvent = internalAction({
  args: {
    eventId: v.id("whopWebhookEvents"),
    type: v.string(),
    providerPaymentId: v.string(),
    requestId: v.union(v.string(), v.null()),
    quoteVersion: v.union(v.string(), v.null()),
    amountCents: v.union(v.number(), v.null()),
    currency: v.union(v.string(), v.null()),
    failed: v.boolean(),
  },
  handler: async (ctx, args) => {
    if (args.failed) {
      await ctx.runMutation(internal.whop.finishEvent, {
        eventId: args.eventId,
        outcome: `payment ${args.providerPaymentId} reported ${args.type}; nothing recorded as money in`,
      });
      return null;
    }
    let recorded: {
      duplicate: boolean;
      paymentId: Id<"payments">;
      mismatch: string | null;
      requestId: Id<"purchaseRequests">;
    };
    try {
      recorded = await ctx.runMutation(internal.whop.savePaid, {
      providerPaymentId: args.providerPaymentId,
      requestId: args.requestId,
      quoteVersion: args.quoteVersion,
      amountCents: args.amountCents,
      currency: args.currency,
        paidAt: Date.now(),
      });
    } catch (e) {
      // A payment we cannot tie to an approved quote is recorded, never dropped.
      await ctx.runMutation(internal.whop.finishEvent, {
        eventId: args.eventId,
        outcome: `payment ${args.providerPaymentId} could not be recorded: ${
          e instanceof Error ? e.message : String(e)
        }`.slice(0, 240),
      });
      return null;
    }
    await ctx.runMutation(internal.whop.finishEvent, {
      eventId: args.eventId,
      outcome: recorded.duplicate
        ? `duplicate delivery for ${args.providerPaymentId}; recorded once`
        : recorded.mismatch
          ? `recorded and rejected: ${recorded.mismatch}`
          : `payment ${args.providerPaymentId} recorded for request ${recorded.requestId}`,
    });
    if (!recorded.duplicate && !recorded.mismatch) {
      await ctx.scheduler.runAfter(0, internal.whop.fulfil, { paymentId: recorded.paymentId });
    }
    return null;
  },
});

export const paymentContext = internalQuery({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const payment = await ctx.db.get("payments", paymentId);
    if (!payment) return null;
    const request = await ctx.db.get("purchaseRequests", payment.requestId);
    if (!request) return null;
    const order = await ctx.db
      .query("orders")
      .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", payment.requestId))
      .unique();
    const offer = await ctx.db.get("offers", request.offerId);
    const subaccount = await ctx.db.get("shopperSubaccounts", payment.subaccountId);
    if (!subaccount) return null;
    return { payment, request, order, offer, subaccount };
  },
});

/**
 * Money out. Re-reads the retailer, refuses a changed total without a fresh
 * approval, checks the subaccount balance, then charges the subaccount's card.
 */
export const fulfil = internalAction({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const billing = await ctx.runQuery(internal.whop.paymentContext, { paymentId });
    if (!billing) return null;
    const { request, order, offer, payment, subaccount } = billing;
    if (!order || !request.quote) return null;
    if (payment.status !== "succeeded") return null;

    const revalidation = await ctx.runAction(internal.enrichment.revalidateOffer, {
      offerId: request.offerId,
    });
    await ctx.runMutation(internal.whop.setOrder, {
      orderId: order._id,
      revalidation: {
        status: revalidation.status,
        checkedAt: Date.now(),
        totalCents: revalidation.totalCents,
        note: revalidation.note,
      },
      revalidatedAt: Date.now(),
    });
    if (revalidation.status !== "unchanged") {
      await ctx.runMutation(internal.whop.setOrder, {
        orderId: order._id,
        status: "requote_required",
        error:
          revalidation.note ??
          "The retailer page changed, so this order needs a fresh approval before any retailer is charged.",
      });
      return null;
    }

    const balance = await ctx.runQuery(internal.whop.ledger, { subaccountId: payment.subaccountId });
    await ctx.runMutation(internal.whop.setSubaccount, {
      subaccountId: payment.subaccountId,
      availableBalanceCents: balance,
      balanceCheckedAt: Date.now(),
    });
    if (balance < request.quote.totalCents) {
      await ctx.runMutation(internal.whop.setOrder, {
        orderId: order._id,
        status: "failed",
        error: `The subaccount holds ${(balance / 100).toFixed(2)} but the order needs ${(
          request.quote.totalCents / 100
        ).toFixed(2)}; no card charge was attempted.`,
      });
      return null;
    }

    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    let card = {
      cardId: subaccount.cardId ?? "",
      last4: subaccount.cardLast4 ?? "0000",
      status: subaccount.cardStatus,
      note: subaccount.cardNote ?? null,
      spendLimitCents: subaccount.cardSpendLimitCents ?? 0,
      transactionLimitCents: subaccount.cardTransactionLimitCents ?? 0,
    };
    if (!subaccount.cardId) {
      const issued = await issueCard(config, {
        subaccountId: subaccount.providerAccountId,
        spendLimitCents: Math.max(request.quote.totalCents, 1000),
        transactionLimitCents: request.quote.totalCents,
        cardholderEmail: "shopper@cart.local",
        cardholderName: "Cart Shopper",
      });
      card = {
        cardId: issued.cardId,
        last4: issued.last4,
        status: issued.status,
        note: issued.note,
        spendLimitCents: issued.spendLimitCents,
        transactionLimitCents: issued.transactionLimitCents,
      };
      await ctx.runMutation(internal.whop.setSubaccount, {
        subaccountId: payment.subaccountId,
        cardId: card.cardId,
        cardLast4: card.last4,
        cardStatus: card.status,
        cardSpendLimitCents: card.spendLimitCents,
        cardTransactionLimitCents: card.transactionLimitCents,
        cardNote: card.note ?? undefined,
        availableBalanceCents: balance,
        balanceCheckedAt: Date.now(),
      });
    }

    // The issuer-side cap is only real with a Rain account; Cart enforces it either way.
    if (card.transactionLimitCents > 0 && request.quote.totalCents > card.transactionLimitCents) {
      await ctx.runMutation(internal.whop.setOrder, {
        orderId: order._id,
        status: "failed",
        error: "The order total exceeds the card's per-charge limit; no charge was attempted.",
      });
      return null;
    }

    const charge = await chargeCard(config, {
      cardId: card.cardId,
      amountCents: request.quote.totalCents,
      currency: request.quote.currency ?? "USD",
      merchantName: offer?.retailerName ?? "Retailer",
      orderReference: order.orderRef,
    });
    await ctx.runMutation(internal.whop.saveCharge, {
      shopperId: request.shopperId,
      subaccountId: payment.subaccountId,
      requestId: request._id,
      quoteVersion: request.quoteVersion,
      orderId: order._id,
      cardId: card.cardId,
      amountCents: request.quote.totalCents,
      currency: request.quote.currency ?? "USD",
      providerTransactionId: charge.transactionId,
      ok: charge.ok,
      error: charge.error,
      note: card.note,
      merchantName: offer?.retailerName ?? "Retailer",
      orderReference: order.orderRef,
      unknown: !charge.ok && charge.transactionId === null && !charge.simulated,
    });
    if (!charge.ok) {
      await ctx.runMutation(internal.whop.setOrder, {
        orderId: order._id,
        status: charge.error ? "failed" : "unknown",
        error:
          charge.error ?? "The card charge outcome never came back; it stays processing until reconciled.",
      });
      return null;
    }
    await ctx.runMutation(internal.whop.setOrder, { orderId: order._id, status: "submitting" });
    await ctx.scheduler.runAfter(0, internal.orders.submitOrder, { orderId: order._id });
    return null;
  },
});

export const orderForRefund = internalQuery({
  args: { orderId: v.id("orders") },
  handler: async (ctx, { orderId }) => {
    const order = await ctx.db.get("orders", orderId);
    if (!order || !order.paymentId) return null;
    const payment = await ctx.db.get("payments", order.paymentId);
    if (!payment) return null;
    return { order, payment };
  },
});

export const markRefunded = internalMutation({
  args: {
    paymentId: v.id("payments"),
    refundId: v.string(),
    amountCents: v.number(),
    cardTransactionId: v.optional(v.id("cardTransactions")),
    orderId: v.id("orders"),
  },
  handler: async (ctx, { paymentId, refundId, amountCents, cardTransactionId, orderId }) => {
    const now = Date.now();
    await ctx.db.patch("payments", paymentId, {
      status: "refunded",
      refundId,
      refundAmountCents: amountCents,
      refundedAt: now,
      updatedAt: now,
    });
    if (cardTransactionId) {
      await ctx.db.patch("cardTransactions", cardTransactionId, { status: "released", updatedAt: now });
    }
    await ctx.db.patch("orders", orderId, { refundedAt: now });
    return null;
  },
});

/** Refunds from the subaccount and releases the card hold for the same order. */
export const refundOrder = internalAction({
  args: { orderId: v.id("orders"), reason: v.optional(v.string()) },
  handler: async (ctx, { orderId, reason }) => {
    const context = await ctx.runQuery(internal.whop.orderForRefund, { orderId });
    if (!context) return null;
    const { order, payment } = context;
    if (!payment.providerPaymentId) return null;
    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    const refund = await refundPayment(config, {
      paymentId: payment.providerPaymentId,
      reason: reason ?? "Cart could not fulfil the retailer order",
    });
    if (!refund.ok) {
      await ctx.runMutation(internal.whop.setOrder, { orderId, error: `Refund failed: ${refund.error}` });
      return null;
    }
    await ctx.runMutation(internal.whop.markRefunded, {
      paymentId: payment._id,
      refundId: refund.data.id,
      amountCents: payment.amountCents,
      cardTransactionId: order.cardTransactionId,
      orderId,
    });
    return null;
  },
});

/**
 * Sandbox proof harness, internal and CLI-only: it fabricates an approved request
 * with an exact quote for one hosted payment, so a real sandbox payment can be
 * traced through the webhook without driving the whole app. Never exposed publicly.
 */
export const startSandboxPayment = internalAction({
  args: {
    amountCents: v.number(),
    email: v.optional(v.string()),
    label: v.optional(v.string()),
  },
  handler: async (
    ctx,
    { amountCents, email, label },
  ): Promise<{ requestId: Id<"purchaseRequests">; paymentId: Id<"payments">; checkoutUrl: string | null }> => {
    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    const seeded = await ctx.runMutation(internal.whop.createSandboxRequest, {
      amountCents,
      email: email ?? "sandbox-shopper@cart.app",
      label: label ?? "Cart sandbox payment",
    });
    const subaccountId = await ctx.runAction(internal.whop.ensureSubaccount, {
      shopperId: seeded.shopperId,
      email: email ?? "sandbox-shopper@cart.app",
      name: "Sandbox shopper",
    });
    const subaccount = await ctx.runQuery(internal.whop.subaccount, { shopperId: seeded.shopperId });
    if (!subaccount) throw new Error("Subaccount vanished after creation");
    const checkout = await createCheckoutConfiguration(config, {
      subaccountId: subaccount.providerAccountId,
      amountCents,
      currency: "USD",
      title: label ?? "Cart sandbox payment",
      requestId: seeded.requestId,
      quoteVersion: seeded.quoteVersion,
    });
    if (!checkout.ok) throw new Error(checkout.error);
    const paymentId = await ctx.runMutation(internal.whop.savePayment, {
      shopperId: seeded.shopperId,
      requestId: seeded.requestId,
      quoteVersion: seeded.quoteVersion,
      subaccountId,
      checkoutConfigId: checkout.data.id,
      checkoutUrl: checkout.data.purchase_url ?? null,
      amountCents,
      currency: "USD",
    });
    return { requestId: seeded.requestId, paymentId, checkoutUrl: checkout.data.purchase_url ?? null };
  },
});

export const createSandboxRequest = internalMutation({
  args: { amountCents: v.number(), email: v.string(), label: v.string() },
  handler: async (ctx, { amountCents, email, label }) => {
    const now = Date.now();
    const shopperId = await ctx.db.insert("users", { name: "Sandbox shopper", email, isAnonymous: true });
    const productId = await ctx.db.insert("products", {
      title: `${label} (sandbox)`,
      category: "general",
    });
    const variantId = await ctx.db.insert("variants", { productId, label: "Default" });
    const offerId = await ctx.db.insert("offers", {
      productId,
      variantId,
      retailer: "sandbox",
      retailerName: "Sandbox retailer",
      seller: "Sandbox retailer",
      url: "https://example.com/sandbox-offer",
      canonicalKey: `sandbox:${now}`,
      priceCents: amountCents,
      shippingCents: 0,
      currency: "USD",
      deliveryEstimate: "Delivery estimate unavailable",
      returnSummary: "Sandbox offer for the Whop payment proof.",
      conditionClass: "unknown" as const,
      inStock: true,
      simulated: true,
      updatedAt: now,
    });
    const cartItemId = await ctx.db.insert("cartItems", {
      shopperId,
      url: "https://example.com/sandbox-offer",
      productId,
      variantId,
      offerId,
      quantity: 1,
      reason: "Whop sandbox payment proof",
      addedBy: "agent" as const,
      status: "active" as const,
      enrichmentStatus: "ready" as const,
      idempotencyKey: `sandbox-${now}`,
      addedAt: now,
    });
    const quote = {
      retailer: "sandbox",
      retailerName: "Sandbox retailer",
      seller: "Sandbox retailer",
      productTitle: `${label} (sandbox)`,
      variantLabel: "Default",
      quantity: 1,
      unitPriceCents: amountCents,
      subtotalCents: amountCents,
      taxCents: 0,
      shippingCents: 0,
      totalCents: amountCents,
      currency: "USD",
      deliveryEstimate: "Delivery estimate unavailable",
      returnSummary: "Sandbox offer for the Whop payment proof.",
      quotedAt: now,
      simulated: true,
    };
    const requestId = await ctx.db.insert("purchaseRequests", {
      shopperId,
      cartItemId,
      offerId,
      quantity: 1,
      reason: "Whop sandbox payment proof",
      requestedBy: "agent" as const,
      idempotencyKey: `sandbox-request-${now}`,
      status: "approved" as const,
      quoteVersion: 1,
      quote,
      expiresAt: now + 60 * 60_000,
      decidedAt: now,
    });
    await ctx.db.insert("orders", {
      shopperId,
      purchaseRequestId: requestId,
      cartItemId,
      orderRef: `SBX-${now.toString(36).toUpperCase()}`,
      retailer: "sandbox",
      status: "awaiting_payment" as const,
      quoteVersion: 1,
      quote,
      submitAttempts: 0,
      simulated: true,
    });
    return { shopperId, requestId, quoteVersion: 1 };
  },
});

/**
 * Sandbox repair, internal and CLI-only: a probe payment must never stand in for a
 * real one, so this puts a row polluted by a probe back to pending.
 */
export const resetProbePayment = internalMutation({
  args: { paymentId: v.id("payments") },
  handler: async (ctx, { paymentId }) => {
    const payment = await ctx.db.get("payments", paymentId);
    if (!payment) return null;
    if (!payment.providerPaymentId?.startsWith("pay_probe")) {
      throw new Error("Refusing to reset a payment that did not come from a probe.");
    }
    await ctx.db.patch("payments", paymentId, {
      status: "pending",
      providerPaymentId: undefined,
      paidAt: undefined,
      failureReason: undefined,
      updatedAt: Date.now(),
    });
    return { paymentId, status: "pending" as const };
  },
});
