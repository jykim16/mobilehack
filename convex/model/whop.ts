import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { notFound } from "../lib/auth";

/** The shopper's own Whop subaccount, which holds their money and their card. */
export async function subaccountFor(ctx: QueryCtx, shopperId: Id<"users">) {
  return await ctx.db
    .query("shopperSubaccounts")
    .withIndex("by_shopperId", (q) => q.eq("shopperId", shopperId))
    .first();
}

export async function requireSubaccount(ctx: QueryCtx, shopperId: Id<"users">) {
  const row = await subaccountFor(ctx, shopperId);
  if (!row) notFound("Whop subaccount");
  return row;
}

export type SubaccountInput = {
  shopperId: Id<"users">;
  providerAccountId: string;
  environment: "sandbox" | "production";
  kycRequired: boolean;
  status: "pending_kyc" | "active" | "restricted" | "failed";
};

export async function recordSubaccountFor(ctx: MutationCtx, input: SubaccountInput) {
  // Identity is the shopper, not the provider account: the sandbox demo reuses one
  // pre-verified subaccount across shoppers, and each still needs its own row.
  const existing = await ctx.db
    .query("shopperSubaccounts")
    .withIndex("by_shopperId", (q) => q.eq("shopperId", input.shopperId))
    .first();
  const now = Date.now();
  if (existing) {
    await ctx.db.patch("shopperSubaccounts", existing._id, {
      status: input.status,
      updatedAt: now,
    });
    return existing._id;
  }
  return await ctx.db.insert("shopperSubaccounts", {
    shopperId: input.shopperId,
    provider: "whop",
    providerAccountId: input.providerAccountId,
    environment: input.environment,
    status: input.status,
    kycRequired: input.kycRequired,
    cardStatus: "none",
    createdAt: now,
    updatedAt: now,
  });
}

/** Money already in, minus what the card has already spent. */
/**
 * Money in minus card spend for one subaccount, read from its own rows only: a
 * refund subtracts the amount that came back, never twice, and never to a negative.
 */
export async function ledgerBalanceCents(ctx: QueryCtx, subaccountId: Id<"shopperSubaccounts">) {
  const payments = await ctx.db
    .query("payments")
    .withIndex("by_subaccountId", (q) => q.eq("subaccountId", subaccountId))
    .take(200);
  let inCents = 0;
  for (const payment of payments) {
    if (payment.status === "succeeded" || payment.status === "partially_refunded") {
      inCents += payment.amountCents;
    }
    if (payment.status === "refunded") inCents += 0;
    if (payment.refundAmountCents) inCents -= payment.refundAmountCents;
  }
  const charges = await ctx.db
    .query("cardTransactions")
    .withIndex("by_subaccountId", (q) => q.eq("subaccountId", subaccountId))
    .take(200);
  let outCents = 0;
  for (const charge of charges) {
    if (charge.status === "succeeded") outCents += charge.amountCents;
  }
  return Math.max(0, inCents - outCents);
}

export async function pendingPaymentFor(ctx: QueryCtx, requestId: Id<"purchaseRequests">) {
  const rows = await ctx.db
    .query("payments")
    .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
    .take(20);
  return rows.find((r) => r.status === "pending") ?? rows[rows.length - 1] ?? null;
}

export type PendingPaymentInput = {
  shopperId: Id<"users">;
  requestId: Id<"purchaseRequests">;
  quoteVersion: number;
  subaccountId: Id<"shopperSubaccounts">;
  checkoutConfigId: string | null;
  checkoutUrl: string | null;
  amountCents: number;
  currency: string;
};

export async function createPendingPayment(ctx: MutationCtx, input: PendingPaymentInput) {
  const now = Date.now();
  const existing = await ctx.db
    .query("payments")
    .withIndex("by_requestId", (q) => q.eq("requestId", input.requestId))
    .take(20);
  const pending = existing.find((r) => r.status === "pending" && r.quoteVersion === input.quoteVersion);
  if (pending) {
    await ctx.db.patch("payments", pending._id, {
      providerCheckoutConfigId: input.checkoutConfigId ?? pending.providerCheckoutConfigId,
      checkoutUrl: input.checkoutUrl ?? pending.checkoutUrl,
      amountCents: input.amountCents,
      currency: input.currency,
      updatedAt: now,
    });
    return pending._id;
  }
  const paymentId = await ctx.db.insert("payments", {
    shopperId: input.shopperId,
    requestId: input.requestId,
    quoteVersion: input.quoteVersion,
    subaccountId: input.subaccountId,
    providerCheckoutConfigId: input.checkoutConfigId ?? undefined,
    checkoutUrl: input.checkoutUrl ?? undefined,
    amountCents: input.amountCents,
    currency: input.currency,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  const order = await ctx.db
    .query("orders")
    .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", input.requestId))
    .unique();
  if (order) {
    await ctx.db.patch("orders", order._id, {
      paymentId,
      subaccountId: input.subaccountId,
      status: "awaiting_payment",
    });
  }
  return paymentId;
}

export type WebhookEventInput = {
  providerEventId: string;
  type: string;
  signatureVerified: boolean;
  payloadDigest: string;
};

/** Records a delivery once. A replayed event id is a no-op, never a second payment. */
export async function recordEventOnce(ctx: MutationCtx, input: WebhookEventInput) {
  const existing = await ctx.db
    .query("whopWebhookEvents")
    .withIndex("by_providerEventId", (q) => q.eq("providerEventId", input.providerEventId))
    .first();
  if (existing) {
    // A delivery we rejected for a bad signature must not block the provider's
    // verified retry of the same event.
    if (!existing.signatureVerified && input.signatureVerified && existing.processedAt === undefined) {
      await ctx.db.patch("whopWebhookEvents", existing._id, { signatureVerified: true });
      return { firstTime: true, eventId: existing._id, processed: false };
    }
    return { firstTime: false, eventId: existing._id, processed: existing.processedAt !== undefined };
  }
  const eventId = await ctx.db.insert("whopWebhookEvents", {
    providerEventId: input.providerEventId,
    type: input.type,
    receivedAt: Date.now(),
    signatureVerified: input.signatureVerified,
    payloadDigest: input.payloadDigest,
  });
  return { firstTime: true, eventId, processed: false };
}

export async function markEventProcessed(
  ctx: MutationCtx,
  eventId: Id<"whopWebhookEvents">,
  outcome: string,
) {
  await ctx.db.patch("whopWebhookEvents", eventId, { processedAt: Date.now(), outcome: outcome.slice(0, 240) });
}

export type PaidInput = {
  providerPaymentId: string;
  requestId: string | null;
  quoteVersion: string | null;
  amountCents: number | null;
  currency: string | null;
  paidAt: number;
};

/**
 * Matches the money to the approved quote it belongs to and records it once. An
 * amount or currency that disagrees with the quote is recorded and rejected rather
 * than promoted to a payment.
 */
export async function recordPaid(ctx: MutationCtx, input: PaidInput) {
  const existing = await ctx.db
    .query("payments")
    .withIndex("by_providerPaymentId", (q) => q.eq("providerPaymentId", input.providerPaymentId))
    .first();
  if (existing) return { duplicate: true, paymentId: existing._id, mismatch: null as string | null, requestId: existing.requestId };

  let request: Awaited<ReturnType<typeof ctx.db.get<"purchaseRequests">>> = null;
  if (input.requestId) {
    // A metadata id we never issued is not a decode error to surface: it is simply
    // a payment that matches no Cart quote, and it is recorded as such.
    try {
      request = await ctx.db.get("purchaseRequests", input.requestId as Id<"purchaseRequests">);
    } catch {
      request = null;
    }
  }
  if (!request) {
    // Equal amounts are not identity: a delivery we cannot tie to a Cart quote is
    // left unmatched rather than credited to whoever happens to hold that amount.
    throw new ConvexError({
      code: "UNMATCHED_PAYMENT",
      message: "A payment arrived without a Cart request in its metadata; nothing was recorded against an order.",
    });
  }

  const row = await ctx.db
    .query("payments")
    .withIndex("by_requestId", (q) => q.eq("requestId", request!._id))
    .take(20);
  const quoteVersion = input.quoteVersion ? Number(input.quoteVersion) : request.quoteVersion;
  const payment = row.find((p) => p.status === "pending" && p.quoteVersion === quoteVersion);
  if (!payment) {
    throw new ConvexError({
      code: "UNMATCHED_PAYMENT",
      message: "No pending payment matches that quote version; nothing was recorded.",
    });
  }
  if (request.status !== "approved") {
    throw new ConvexError({
      code: "INVALID_STATE",
      message: "The purchase request for this payment is not approved; nothing was recorded.",
    });
  }

  const expected = request.quote?.totalCents ?? null;
  const mismatch =
    input.amountCents === null
      ? "The provider did not report an amount, so the payment could not be matched to the quote."
      : expected !== null && input.amountCents !== null && expected !== input.amountCents
      ? `Payment was ${input.amountCents} but the approved quote was ${expected}.`
      : input.currency && request.quote && input.currency.toLowerCase() !== request.quote.currency?.toLowerCase()
        ? `Payment currency ${input.currency} does not match the quote currency ${request.quote.currency}.`
        : null;

  const now = Date.now();
  await ctx.db.patch("payments", payment._id, {
    providerPaymentId: input.providerPaymentId,
    status: mismatch ? "failed" : "succeeded",
    amountCents: input.amountCents ?? payment.amountCents,
    currency: (input.currency ?? payment.currency).toUpperCase(),
    paidAt: mismatch ? undefined : input.paidAt,
    failureReason: mismatch ?? undefined,
    updatedAt: now,
  });
  if (mismatch) {
    const order = await ctx.db
      .query("orders")
      .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", request!._id))
      .unique();
    if (order) await ctx.db.patch("orders", order._id, { error: mismatch });
  }
  return { duplicate: false, paymentId: payment._id, mismatch, requestId: request._id };
}

export async function recordCharge(
  ctx: MutationCtx,
  input: {
    shopperId: Id<"users">;
    subaccountId: Id<"shopperSubaccounts">;
    requestId: Id<"purchaseRequests">;
    quoteVersion: number;
    orderId: Id<"orders">;
    cardId: string;
    amountCents: number;
    currency: string;
    providerTransactionId: string | null;
    ok: boolean;
    error: string | null;
    note: string | null;
    merchantName: string;
    orderReference: string;
    unknown: boolean;
  },
) {
  const now = Date.now();
  const chargeId = await ctx.db.insert("cardTransactions", {
    shopperId: input.shopperId,
    subaccountId: input.subaccountId,
    requestId: input.requestId,
    quoteVersion: input.quoteVersion,
    orderId: input.orderId,
    cardId: input.cardId,
    amountCents: input.amountCents,
    currency: input.currency,
    status: input.unknown ? "processing" : input.ok ? "succeeded" : "failed",
    providerTransactionId: input.providerTransactionId ?? undefined,
    merchantName: input.merchantName,
    orderReference: input.orderReference,
    unknownCharge: input.unknown,
    note: input.error ?? input.note ?? undefined,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch("orders", input.orderId, { cardTransactionId: chargeId });
  return chargeId;
}

export async function patchSubaccount(
  ctx: MutationCtx,
  subaccountId: Id<"shopperSubaccounts">,
  patch: Record<string, unknown>,
) {
  await ctx.db.patch("shopperSubaccounts", subaccountId, { ...patch, updatedAt: Date.now() });
}

export async function orderForRequest(ctx: QueryCtx, requestId: Id<"purchaseRequests">) {
  return await ctx.db
    .query("orders")
    .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", requestId))
    .unique();
}
