import { ConvexError, v } from "convex/values";
import { action, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireShopper } from "./lib/auth";
import { ledgerBalanceCents, subaccountFor } from "./model/whop";

const paymentView = {
  paymentId: v.id("payments"),
  status: v.union(
    v.literal("pending"),
    v.literal("succeeded"),
    v.literal("failed"),
    v.literal("refunded"),
    v.literal("partially_refunded"),
    v.literal("disputed"),
  ),
  amountCents: v.number(),
  currency: v.string(),
  quoteVersion: v.number(),
  checkoutUrl: v.union(v.string(), v.null()),
  providerPaymentId: v.union(v.string(), v.null()),
  paidAt: v.union(v.number(), v.null()),
  failureReason: v.union(v.string(), v.null()),
};

/**
 * Starts hosted payment for the exact quote version the shopper approved. A retried
 * tap with the same idempotency key returns the checkout already created for that
 * quote, so no second checkout is ever opened for one approval.
 */
export const startPayment = action({
  returns: v.object({ ...paymentView, reused: v.boolean() }),
  args: {
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, { requestId, quoteVersion, idempotencyKey }): Promise<StartPaymentResult> => {
    const shopperId = await requireShopper(ctx);
    const request = await ctx.runQuery(internal.purchases.getRequestInternal, { requestId });
    if (!request || request.shopperId !== shopperId) {
      throw new ConvexError({ code: "NOT_FOUND", message: "Purchase request not found." });
    }
    if (request.status !== "approved") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "The quote is not approved, so payment cannot start.",
      });
    }
    if (request.quoteVersion !== quoteVersion) {
      throw new ConvexError({
        code: "STALE_QUOTE",
        message: `This quote is version ${request.quoteVersion}; approve the current one before paying.`,
      });
    }
    if (!request.quote) {
      throw new ConvexError({ code: "INVALID_STATE", message: "The quote has no amount to charge." });
    }

    const existing = await ctx.runQuery(internal.whop.pendingPayment, { requestId });
    if (existing?.checkoutUrl && existing.quoteVersion === quoteVersion) {
      return {
        paymentId: existing._id,
        status: existing.status,
        amountCents: existing.amountCents,
        currency: existing.currency,
        quoteVersion: existing.quoteVersion,
        checkoutUrl: existing.checkoutUrl,
        providerPaymentId: existing.providerPaymentId ?? null,
        paidAt: existing.paidAt ?? null,
        failureReason: existing.failureReason ?? null,
        reused: true,
      };
    }

    await ctx.runAction(internal.whop.fundPurchase, { requestId });
    const created = await ctx.runQuery(internal.whop.pendingPayment, { requestId });
    if (!created) {
      throw new ConvexError({
        code: "CHECKOUT_UNAVAILABLE",
        message: "The hosted checkout could not be opened. Nothing was charged; try again shortly.",
      });
    }
    void idempotencyKey;
    return {
      paymentId: created._id,
      status: created.status,
      amountCents: created.amountCents,
      currency: created.currency,
      quoteVersion: created.quoteVersion,
      checkoutUrl: created.checkoutUrl ?? null,
      providerPaymentId: created.providerPaymentId ?? null,
      paidAt: created.paidAt ?? null,
      failureReason: created.failureReason ?? null,
      reused: false,
    };
  },
});

/** Payment state for a request: paid is its own event, never a stand-in for placed. */
export const status = query({
  args: { requestId: v.id("purchaseRequests") },
  handler: async (ctx, { requestId }) => {
    const shopperId = await requireShopper(ctx);
    const request = await ctx.db.get("purchaseRequests", requestId);
    if (!request || request.shopperId !== shopperId) return null;
    const rows = await ctx.db
      .query("payments")
      .withIndex("by_requestId", (q) => q.eq("requestId", requestId))
      .take(20);
    const payment = rows.find((r) => r.status === "succeeded") ?? rows[rows.length - 1] ?? null;
    const order = await ctx.db
      .query("orders")
      .withIndex("by_purchaseRequestId", (q) => q.eq("purchaseRequestId", requestId))
      .unique();
    return {
      requestStatus: request.status,
      quoteVersion: request.quoteVersion,
      quoteTotalCents: request.quote?.totalCents ?? null,
      payment: payment
        ? {
            paymentId: payment._id,
            status: payment.status,
            amountCents: payment.amountCents,
            currency: payment.currency,
            quoteVersion: payment.quoteVersion,
            checkoutUrl: payment.checkoutUrl ?? null,
            providerPaymentId: payment.providerPaymentId ?? null,
            paidAt: payment.paidAt ?? null,
            failureReason: payment.failureReason ?? null,
          }
        : null,
      order: order
        ? {
            orderId: order._id,
            status: order.status,
            orderRef: order.orderRef,
            placedAt: order.placedAt ?? null,
            revalidatedAt: order.revalidatedAt ?? null,
            revalidation: order.revalidation ?? null,
            refundedAt: order.refundedAt ?? null,
          }
        : null,
    };
  },
});

/** The shopper's own subaccount: what the card can spend, and what is still settling. */
export const subaccount = query({
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    const row = await subaccountFor(ctx, shopperId);
    if (!row) {
      return {
        exists: false as const,
        kycRequired: true,
        availableCents: 0,
        pendingCents: 0,
        cardStatus: "none" as const,
        cardLast4: null,
        spendLimitCents: null,
        transactionLimitCents: null,
        checkedAt: null,
      };
    }
    const availableCents = await ledgerBalanceCents(ctx, row._id);
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", "pending"))
      .take(20);
    const pendingCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    return {
      exists: true as const,
      providerAccountId: row.providerAccountId,
      environment: row.environment,
      status: row.status,
      kycRequired: row.kycRequired,
      availableCents,
      pendingCents,
      cardStatus: row.cardStatus,
      cardLast4: row.cardLast4 ?? null,
      spendLimitCents: row.cardSpendLimitCents ?? null,
      transactionLimitCents: row.cardTransactionLimitCents ?? null,
      cardNote: row.cardNote ?? null,
      checkedAt: row.balanceCheckedAt ?? null,
    };
  },
});

export type StartPaymentResult = {
  paymentId: Id<"payments">;
  status: "pending" | "succeeded" | "failed" | "refunded" | "partially_refunded" | "disputed";
  amountCents: number;
  currency: string;
  quoteVersion: number;
  checkoutUrl: string | null;
  providerPaymentId: string | null;
  paidAt: number | null;
  failureReason: string | null;
  reused: boolean;
};
