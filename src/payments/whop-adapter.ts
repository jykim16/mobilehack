import type { AccountBalance, ApprovedQuote, HostedPayment, OrderStages, PaymentSnapshot, PaymentStatus } from './model';

export type WhopAccountPayload = {
  exists: boolean;
  environment: 'sandbox' | 'production';
  mode: 'whop_sandbox' | 'whop_production' | null;
  capabilities: {
    paymentCollection: 'whop';
    cardIssuance: 'simulated' | 'whop';
    cardCharges: 'simulated' | 'whop';
    retailerOrdering: 'simulated';
    cardNumbersExposed: false;
  };
  kycRequired: boolean;
  providerBalance: {
    availableCents: number | null;
    pendingCents: number | null;
    currency: string | null;
    fetchedAt: number | null;
  } | null;
  card: { status: string; maskedCard: string | null; last4: string | null; simulated: boolean } | null;
};

export type WhopStatusPayload = {
  requestStatus: string;
  quoteVersion: number;
  quoteTotalCents: number | null;
  payment: (HostedPayment & { status: string; quoteVersion: number; paidAt: number | null; failureReason: string | null }) | null;
  order: { status: string; placedAt: number | null; refundedAt: number | null } | null;
};

export function providerBalance(account: WhopAccountPayload): AccountBalance {
  return {
    availableCents: account.providerBalance?.availableCents ?? null,
    pendingCents: account.providerBalance?.pendingCents ?? null,
    currency: account.providerBalance?.currency ?? null,
    fetchedAt: account.providerBalance?.fetchedAt ?? null,
    kycRequired: account.kycRequired,
    ownershipConfirmed: false,
  };
}

export function isSandboxDemo(account: WhopAccountPayload): boolean {
  return account.exists && account.environment === 'sandbox' && account.mode === 'whop_sandbox'
    && account.capabilities.cardIssuance === 'simulated' && account.capabilities.cardCharges === 'simulated'
    && account.capabilities.retailerOrdering === 'simulated' && account.capabilities.cardNumbersExposed === false;
}

export function paymentSnapshot(request: ApprovedQuote, payload: WhopStatusPayload, account: WhopAccountPayload): PaymentSnapshot | null {
  const payment = payload.payment;
  if (!payment) return null;
  if (payload.quoteVersion !== request.quoteVersion || payment.quoteVersion !== request.quoteVersion
    || payload.quoteTotalCents !== request.quote.totalCents || payment.amountCents !== request.quote.totalCents
    || payment.currency !== request.quote.currency) throw new Error('Payment does not match the current quote');
  const statuses: Record<string, PaymentStatus> = {
    pending: 'awaiting_payment', succeeded: 'paid', failed: 'failed', refunded: 'refunded',
    partially_refunded: 'partially_refunded', disputed: 'disputed',
  };
  const sandbox = isSandboxDemo(account);
  const last4 = account.card?.last4;
  const synthetic = sandbox && account.card?.simulated === true;
  const validMask = typeof last4 === 'string' && /^\d{4}$/.test(last4) && account.card?.maskedCard === `•••• ${last4}`;
  return {
    ...request,
    status: ['approved', 'ordered'].includes(payload.requestStatus) && Object.hasOwn(statuses, payment.status) ? statuses[payment.status] : 'unknown',
    payment: { paymentId: payment.paymentId, checkoutUrl: payment.checkoutUrl, amountCents: payment.amountCents, currency: payment.currency },
    updatedAt: null,
    failureReason: payment.failureReason ?? undefined,
    sandbox,
    card: synthetic ? { status: 'simulated', last4: validMask ? last4 : null } : null,
  };
}

export function orderStages(payload: WhopStatusPayload, account: WhopAccountPayload, shipment: { simulated: boolean; events: { status: string; occurredAt: number }[] } | null): OrderStages {
  const paid = ['succeeded', 'refunded', 'partially_refunded', 'disputed'].includes(payload.payment?.status ?? '');
  const simulated = isSandboxDemo(account);
  const shipmentEvent = shipment && (!simulated || shipment.simulated)
    ? shipment.events.find((event) => ['shipped', 'out_for_delivery', 'delivered'].includes(event.status)) : undefined;
  return {
    paymentConfirmedAt: paid ? payload.payment?.paidAt ?? null : null,
    orderPlacedAt: payload.order?.status === 'placed' ? payload.order.placedAt : null,
    shipmentAt: shipmentEvent?.occurredAt ?? null,
    simulated,
    orderStatus: payload.order?.status ?? null,
  };
}
