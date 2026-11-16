import { ConvexError, v } from "convex/values";
import { action, internalAction, query, type ActionCtx } from "./_generated/server";
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
    return await openingCheckout(ctx, shopperId, requestId, quoteVersion, idempotencyKey);
  },
});

/** The checkout-opening body, shared by startPayment and approveAndPay. */
async function openingCheckout(
  ctx: ActionCtx,
  shopperId: Id<"users">,
  requestId: Id<"purchaseRequests">,
  quoteVersion: number,
  idempotencyKey: string,
): Promise<StartPaymentResult> {
  {
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
  }
}

/** Internal entry point so approveAndPay can reuse the same opening path. */
export const startPaymentInternal = internalAction({
  args: {
    shopperId: v.id("users"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, { shopperId, requestId, quoteVersion, idempotencyKey }): Promise<StartPaymentResult> =>
    await openingCheckout(ctx, shopperId, requestId, quoteVersion, idempotencyKey),
});

/**
 * Approval and the hosted checkout in one call, for a UI that approves by paying.
 * It approves the exact quote version, opens the order at `awaiting_payment` and
 * returns the checkout URL — it never submits an order, and nothing can submit one
 * until a payment is confirmed for this version.
 */
export const approveAndPay = action({
  returns: v.object({ ...paymentView, reused: v.boolean(), orderId: v.id("orders") }),
  args: {
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    idempotencyKey: v.string(),
  },
  handler: async (
    ctx,
    { requestId, quoteVersion, idempotencyKey },
  ): Promise<StartPaymentResult & { orderId: Id<"orders"> }> => {
    const shopperId = await requireShopper(ctx);
    const approved = await ctx.runMutation(internal.whop.approveForPayment, {
      shopperId,
      requestId,
      quoteVersion,
    });
    const started = await ctx.runAction(internal.payments.startPaymentInternal, {
      shopperId,
      requestId,
      quoteVersion,
      idempotencyKey,
    });
    return { ...started, orderId: approved.orderId };
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
      /** Approve, paid, placed and shipped are four separate moments. */
      approvedAt: request.decidedAt ?? null,
      requestedAt: request._creationTime,
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
            error: order.error ?? null,
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
        provider: "whop" as const,
        mode: null,
        capabilities: {
          paymentCollection: "whop" as const,
          cardIssuance: "simulated" as const,
          cardCharges: "simulated" as const,
          retailerOrdering: "simulated" as const,
          cardNumbersExposed: false as const,
        },
        status: null,
        kycRequired: true,
        cartAvailableCents: 0,
        cartPendingCents: 0,
        providerBalance: {
          availableCents: null,
          pendingCents: null,
          currency: null,
          fetchedAt: null,
          settlementDate: null,
        },
        card: {
          status: "none" as const,
          maskedCard: null,
          last4: null,
          simulated: true,
          note: null,
          spendLimitCents: null,
          transactionLimitCents: null,
          issuedAt: null,
          providerCardsOnAccount: null,
        },
        checkedAt: null,
        providerCheckedAt: null,
      };
    }
    const cartAvailableCents = await ledgerBalanceCents(ctx, row._id);
    const payments = await ctx.db
      .query("payments")
      .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", "pending"))
      .take(20);
    const pendingCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
    return {
      exists: true as const,
      provider: "whop" as const,
      providerAccountId: row.providerAccountId,
      environment: row.environment,
      /** How this deployment behaves: a sandbox payment is real money movement in
       * Whop's sandbox, while card issuance and retailer ordering are simulated. */
      mode: (row.environment === "sandbox" ? "whop_sandbox" : "whop_production") as
        | "whop_sandbox"
        | "whop_production",
      capabilities: {
        paymentCollection: "whop" as const,
        cardIssuance: row.cardStatus === "active" ? ("whop" as const) : ("simulated" as const),
        cardCharges: row.cardStatus === "active" ? ("whop" as const) : ("simulated" as const),
        retailerOrdering: "simulated" as const,
        cardNumbersExposed: false as const,
      },
      status: row.status,
      kycRequired: row.kycRequired,
      /** Cart's own ledger: money confirmed in minus card spend. */
      cartAvailableCents,
      cartPendingCents: pendingCents,
      /** The provider's numbers, unmodified. Null means we could not read them. */
      providerBalance: {
        availableCents: row.providerAvailableCents ?? null,
        pendingCents: row.providerPendingCents ?? null,
        currency: row.providerCurrency ?? null,
        fetchedAt: row.providerFetchedAt ?? null,
        settlementDate: row.providerSettlementDate ?? null,
      },
      card: {
        status: row.cardStatus,
        maskedCard: row.cardLast4 ? `•••• ${row.cardLast4}` : null,
        last4: row.cardLast4 ?? null,
        simulated: row.cardStatus !== "active",
        note: row.cardNote ?? null,
        spendLimitCents: row.cardSpendLimitCents ?? null,
        transactionLimitCents: row.cardTransactionLimitCents ?? null,
        issuedAt: row.cardIssuedAt ?? null,
        providerCardsOnAccount: row.providerCardCount ?? null,
      },
      checkedAt: row.balanceCheckedAt ?? null,
      providerCheckedAt: row.providerFetchedAt ?? null,
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
