import { ConvexError, v } from "convex/values";
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
  whopFetch,
  whopEnvironment,
} from "./lib/whop";

const readEnv = (name: string): string | undefined =>
  typeof process !== "undefined" ? process.env[name] : undefined;

const subaccountStatus = v.union(
  v.literal("pending_kyc"),
  v.literal("active"),
  v.literal("restricted"),
  v.literal("failed"),
);

export const userContact = internalQuery({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => {
    const user = await ctx.db.get("users", shopperId);
    return { email: user?.email ?? null, name: user?.name ?? null };
  },
});

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
    providerAvailableCents: v.optional(v.number()),
    providerPendingCents: v.optional(v.number()),
    providerCurrency: v.optional(v.string()),
    providerFetchedAt: v.optional(v.number()),
    providerSettlementDate: v.optional(v.string()),
    providerCardCount: v.optional(v.number()),
    providerOnboarding: v.optional(v.string()),
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
    const events = await ctx.db
      .query("whopWebhookEvents")
      .order("desc")
      .take(take);
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
    const contact = await ctx.runQuery(internal.whop.userContact, { shopperId });
    // Sandbox demo reuses one pre-verified subaccount: Whop only creates an account
    // for an address that accepts mail, and anonymous demo shoppers have none.
    const demoAccount = readEnv("WHOP_DEMO_SUBACCOUNT_ID");
    if (demoAccount && whopEnvironment(config.base) === "sandbox") {
      return await ctx.runMutation(internal.whop.saveSubaccount, {
        shopperId,
        providerAccountId: demoAccount,
        environment: "sandbox",
        kycRequired: false,
        status: "active",
      });
    }
    const address = email ?? contact.email;
    if (!address) {
      throw new Error(
        "A Whop subaccount needs a real email address. Sign in with an email before funding with Whop.",
      );
    }
    const created = await createSubaccount(config, {
      title: (name ?? contact.name ?? "Cart shopper").slice(0, 80),
      email: address,
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
      title: "Cart order",
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
      if (/refund/i.test(args.type)) {
        await ctx.runMutation(internal.whop.markRefundFromProvider, {
          providerPaymentId: args.providerPaymentId,
          refundedAt: Date.now(),
        });
      }
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
      approvedTotalCents: request.quote.totalCents,
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
      const contact = await ctx.runQuery(internal.whop.userContact, { shopperId: request.shopperId });
      const issued = await issueCard(config, {
        subaccountId: subaccount.providerAccountId,
        cardholderEmail: contact.email ?? `demo+${request.shopperId.slice(-12)}@cart.app`,
        spendLimitCents: Math.max(request.quote.totalCents, 1000),
        transactionLimitCents: request.quote.totalCents,
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

    // The per-charge cap follows the approved quote, so a second, larger order is not
    // permanently capped by the first. Cart enforces it either way.
    if (request.quote.totalCents > card.transactionLimitCents) {
      card = { ...card, transactionLimitCents: request.quote.totalCents };
      await ctx.runMutation(internal.whop.setSubaccount, {
        subaccountId: payment.subaccountId,
        cardTransactionLimitCents: card.transactionLimitCents,
      });
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
    if (order.simulated) {
      await ctx.runMutation(internal.whop.setOrder, { orderId: order._id, status: "submitting" });
      await ctx.scheduler.runAfter(0, internal.orders.submitOrder, { orderId: order._id });
      return null;
    }
    // Money has moved for a real retailer quote. The simulated adapter must never
    // "place" that order, so it waits for the live session to submit it.
    await ctx.runMutation(internal.whop.setOrder, {
      orderId: order._id,
      status: "awaiting_client",
      error:
        "Payment is confirmed and the card charge is recorded; the retailer submission runs on the shopper's device with its live session.",
    });
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

/**
 * Approval that cannot place an order: the request is marked approved at the given
 * quote version and an order row is opened at `awaiting_payment`, but nothing is
 * ever submitted until a payment is confirmed for that version.
 */
export const approveForPayment = internalMutation({
  args: {
    shopperId: v.id("users"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
  },
  handler: async (ctx, { shopperId, requestId, quoteVersion }) => {
    const request = await ctx.db.get("purchaseRequests", requestId);
    if (!request || request.shopperId !== shopperId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Purchase request not found." });
    }
    if (request.quoteVersion !== quoteVersion) {
      throw new ConvexError({
        code: "STALE_QUOTE",
        message: `This quote is version ${request.quoteVersion}; approve the current one.`,
      });
    }
    if (!request.quote) {
      throw new ConvexError({ code: "INVALID_STATE", message: "The quote has no amount to charge." });
    }
    const now = Date.now();
    if (request.status !== "approved") {
      await ctx.db.patch("purchaseRequests", requestId, { status: "approved", decidedAt: now });
    }
    const existing = await ctx.db
      .query("orders")
      .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", requestId))
      .unique();
    if (existing) {
      if (existing.status === "placed" || existing.status === "submitting") {
        throw new ConvexError({
          code: "INVALID_STATE",
          message: "This order is already moving; it cannot be re-approved for payment.",
        });
      }
      await ctx.db.patch("orders", existing._id, {
        status: "awaiting_payment",
        quote: request.quote,
        quoteVersion: request.quoteVersion,
        error: undefined,
      });
      return { orderId: existing._id, status: "awaiting_payment" as const };
    }
    const offer = await ctx.db.get("offers", request.offerId);
    const orderId = await ctx.db.insert("orders", {
      shopperId,
      purchaseRequestId: requestId,
      cartItemId: request.cartItemId,
      orderRef: `PAY-${requestId.slice(-8).toUpperCase()}`,
      retailer: offer?.retailer ?? request.quote.retailer,
      status: "awaiting_payment",
      quoteVersion: request.quoteVersion,
      quote: request.quote,
      submitAttempts: 0,
      simulated: request.quote.simulated,
    });
    return { orderId, status: "awaiting_payment" as const };
  },
});

/** A refund the provider reports, applied to the payment it names. */
export const markRefundFromProvider = internalMutation({
  args: { providerPaymentId: v.string(), refundedAt: v.number() },
  handler: async (ctx, { providerPaymentId, refundedAt }) => {
    const payment = await ctx.db
      .query("payments")
      .withIndex("by_providerPaymentId", (q) => q.eq("providerPaymentId", providerPaymentId))
      .first();
    if (!payment) return null;
    await ctx.db.patch("payments", payment._id, {
      status: "refunded",
      refundAmountCents: payment.amountCents,
      refundedAt,
      updatedAt: Date.now(),
    });
    return null;
  },
});

export const subaccountByProvider = internalQuery({
  args: { providerAccountId: v.string() },
  handler: async (ctx, { providerAccountId }) =>
    await ctx.db
      .query("shopperSubaccounts")
      .withIndex("by_providerAccountId", (q) => q.eq("providerAccountId", providerAccountId))
      .first(),
});

export const subaccountById = internalQuery({
  args: { subaccountId: v.id("shopperSubaccounts") },
  handler: async (ctx, { subaccountId }) => await ctx.db.get("shopperSubaccounts", subaccountId),
});

/** The provider's own view of a subaccount: balances, card count, onboarding. */
export const providerSnapshot = internalAction({
  args: { subaccountId: v.id("shopperSubaccounts") },
  handler: async (
    ctx,
    { subaccountId },
  ): Promise<{
    availableCents: number | null;
    pendingCents: number | null;
    currency: string | null;
    fetchedAt: number;
    cardCount: number | null;
    onboarding: string | null;
  }> => {
    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    const subaccount = await ctx.runQuery(internal.whop.subaccountById, { subaccountId });
    if (!subaccount) throw new Error("No such subaccount");
    const res = await whopFetch<{
      balances?: { symbol?: string; breakdown?: { available?: string; pending?: string } }[];
      cards?: unknown[];
      onboarding_type?: string | null;
    }>(config, `/accounts/${subaccount.providerAccountId}`);
    if (!res.ok) throw new Error(res.error);
    const account = res.data;
    const balances = Array.isArray(account.balances) ? account.balances : [];
    const usd: { symbol?: string; breakdown?: { available?: string; pending?: string } } | null =
      balances.find((b: { symbol?: string }) => (b.symbol ?? "").toUpperCase() === "USD") ?? balances[0] ?? null;
    const cents = (value: string | undefined): number | null =>
      value === undefined || value === "" ? null : Math.round(Number(value) * 100);
    const availableCents = cents(usd?.breakdown?.available);
    const pendingCents = cents(usd?.breakdown?.pending);
    const currency = usd?.symbol ?? null;
    const fetchedAt = Date.now();
    const cardCount = Array.isArray(account.cards) ? account.cards.length : null;
    await ctx.runMutation(internal.whop.setSubaccount, {
      subaccountId,
      providerAvailableCents: availableCents ?? undefined,
      providerPendingCents: pendingCents ?? undefined,
      providerCurrency: currency ?? undefined,
      providerFetchedAt: fetchedAt,
      providerCardCount: cardCount ?? undefined,
      providerOnboarding: account.onboarding_type ?? undefined,
    });
    return { availableCents, pendingCents, currency, fetchedAt, cardCount, onboarding: account.onboarding_type ?? null };
  },
});

/** Records a second successful charge as its own payment row, tied to its request. */
export const recordExtraPayment = internalMutation({
  args: {
    providerPaymentId: v.string(),
    requestId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    paidAt: v.number(),
    note: v.string(),
  },
  handler: async (ctx, { providerPaymentId, requestId, amountCents, currency, paidAt, note }) => {
    const existing = await ctx.db
      .query("payments")
      .withIndex("by_providerPaymentId", (q) => q.eq("providerPaymentId", providerPaymentId))
      .first();
    if (existing) return existing._id;
    const request = await ctx.db.get("purchaseRequests", requestId as Id<"purchaseRequests">);
    if (!request) throw new Error("The duplicate payment names a request that no longer exists.");
    const siblings = await ctx.db
      .query("payments")
      .withIndex("by_requestId", (q) => q.eq("requestId", request._id))
      .take(20);
    const sibling = siblings.find((p) => p.providerPaymentId !== providerPaymentId);
    if (!sibling) throw new Error("The duplicate payment has no subaccount to attach to.");
    const now = Date.now();
    return await ctx.db.insert("payments", {
      shopperId: request.shopperId,
      requestId: request._id,
      quoteVersion: request.quoteVersion,
      subaccountId: sibling.subaccountId,
      providerPaymentId,
      amountCents,
      currency: currency.toUpperCase(),
      status: "succeeded",
      paidAt,
      failureReason: note,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const markRefundedPayment = internalMutation({
  args: { paymentId: v.id("payments"), refundId: v.string(), amountCents: v.number() },
  handler: async (ctx, { paymentId, refundId, amountCents }) => {
    await ctx.db.patch("payments", paymentId, {
      status: "refunded",
      refundId,
      refundAmountCents: amountCents,
      refundedAt: Date.now(),
      updatedAt: Date.now(),
    });
    return null;
  },
});

/**
 * Reconciliation from the provider's own record, never a replay: records the paid
 * payments a subaccount holds against the quote their metadata names, and refunds a
 * second successful charge for a quote that was already paid.
 */
export const reconcileSubaccount = internalAction({
  args: { subaccountId: v.id("shopperSubaccounts"), refundDuplicates: v.optional(v.boolean()) },
  handler: async (
    ctx,
    { subaccountId, refundDuplicates },
  ): Promise<{
    examined: number;
    recorded: number;
    duplicates: number;
    refunded: string[];
    refundErrors: string[];
    unmatched: string[];
  }> => {
    const config = whopConfig();
    if (!config) throw new Error("Whop is not configured");
    const subaccount = await ctx.runQuery(internal.whop.subaccountById, { subaccountId });
    if (!subaccount) throw new Error("No such subaccount");
    const res = await whopFetch<{ data?: any[] }>(
      config,
      `/payments?account_id=${subaccount.providerAccountId}&first=50`,
    );
    if (!res.ok) throw new Error(res.error);
    const paid = (Array.isArray(res.data.data) ? res.data.data : [])
      .filter((p: any) => p?.status === "paid" && p?.substatus === "succeeded" && typeof p?.id === "string")
      .sort((a: any, b: any) => Date.parse(a.paid_at ?? 0) - Date.parse(b.paid_at ?? 0));
    let recorded = 0;
    let duplicates = 0;
    const refunded: string[] = [];
    const refundErrors: string[] = [];
    const unmatched: string[] = [];
    const firstForQuote = new Map<string, string>();
    for (const payment of paid) {
      const id = payment.id as string;
      const amount = payment?.total?.amount ?? payment?.amount_charged?.amount ?? null;
      const currency = payment?.total?.currency ?? payment?.currency ?? null;
      const metadata = payment?.metadata ?? {};
      const requestId = typeof metadata.requestId === "string" ? metadata.requestId : null;
      const quoteVersion =
        typeof metadata.quoteVersion === "string" ? metadata.quoteVersion : String(metadata.quoteVersion ?? "");
      const quoteKey = requestId ? `${requestId}:${quoteVersion}` : null;
      const earlier = quoteKey ? firstForQuote.get(quoteKey) : undefined;
      if (quoteKey && !earlier) firstForQuote.set(quoteKey, id);
      const amountCents = amount === null ? 0 : Math.round(Number(amount) * 100);
      try {
        if (quoteKey && earlier) {
          duplicates++;
          const extra = await ctx.runMutation(internal.whop.recordExtraPayment, {
            providerPaymentId: id,
            requestId: requestId!,
            amountCents,
            currency: typeof currency === "string" ? currency : "USD",
            paidAt: payment?.paid_at ? Date.parse(payment.paid_at) : Date.now(),
            note: `Duplicate charge for quote ${quoteVersion}; the first payment was ${earlier}.`,
          });
          if (refundDuplicates) {
            const refund = await refundPayment(config, {
              paymentId: id,
              reason: "Duplicate charge for an already-paid Cart quote",
            });
            if (refund.ok) {
              await ctx.runMutation(internal.whop.markRefundedPayment, {
                paymentId: extra,
                refundId: refund.data.id,
                amountCents,
              });
              refunded.push(id);
            } else if (/refundable|already|refunded/i.test(refund.error)) {
              // The provider already refunded it; keep our ledger in step.
              await ctx.runMutation(internal.whop.markRefundedPayment, {
                paymentId: extra,
                refundId: "refunded-by-provider",
                amountCents,
              });
              refunded.push(id);
            } else {
              refundErrors.push(`${id}: ${refund.error}`);
            }
          }
          continue;
        }
        const result = await ctx.runMutation(internal.whop.savePaid, {
          providerPaymentId: id,
          requestId,
          quoteVersion: quoteVersion === "" ? null : quoteVersion,
          amountCents: amount === null ? null : amountCents,
          currency: typeof currency === "string" ? currency : null,
          paidAt: payment?.paid_at ? Date.parse(payment.paid_at) : Date.now(),
        });
        if (result.duplicate) duplicates++;
        else if (result.mismatch) unmatched.push(`${id}: ${result.mismatch}`);
        else recorded++;
      } catch (e) {
        unmatched.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { examined: paid.length, recorded, duplicates, refunded, refundErrors, unmatched };
  },
});

/** Read-only audit of which Cart shopper holds the live agent connections. */
export const museAudit = internalQuery({
  args: { label: v.optional(v.string()) },
  handler: async (ctx, { label }) => {
    const wanted = (label ?? "muse").toLowerCase();
    const tokens = await ctx.db.query("mcpTokens").take(200);
    const connections = tokens
      .filter((t) => t.kind === "connection" && !t.revokedAt)
      .filter((t) => (t.label ?? "").toLowerCase().includes(wanted))
      .map((t) => ({ tokenId: t._id, label: t.label ?? null, shopperId: t.shopperId, createdAt: t.createdAt }));
    const shopperIds = [...new Set(connections.map((c) => c.shopperId))];
    const recentAgentItems: {
      shopperId: Id<"users">;
      url: string;
      addedAt: number;
      addedBy: string;
    }[] = [];
    for (const shopperId of shopperIds) {
      const items = await ctx.db
        .query("cartItems")
        .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId))
        .order("desc")
        .take(10);
      for (const item of items) {
        recentAgentItems.push({ shopperId, url: item.url.slice(0, 90), addedAt: item.addedAt, addedBy: item.addedBy });
      }
    }
    const subaccounts = (await ctx.db.query("shopperSubaccounts").take(50)).map((row) => ({
      subaccountId: row._id,
      shopperId: row.shopperId,
      providerAccountId: row.providerAccountId,
      status: row.status,
      environment: row.environment,
    }));
    const payments = (await ctx.db.query("payments").take(50)).map((p) => ({
      paymentId: p._id,
      shopperId: p.shopperId,
      subaccountId: p.subaccountId,
      status: p.status,
      providerPaymentId: p.providerPaymentId ?? null,
      amountCents: p.amountCents,
    }));
    return { connections, recentAgentItems, subaccounts, payments };
  },
});
