import type { Quote } from '../data/types';

export type PaymentStatus = 'awaiting_payment' | 'paid' | 'failed' | 'cancelled' | 'abandoned' | 'refunded' | 'unknown';

export type ApprovedQuote = {
  requestId: string;
  quoteVersion: number;
  quote: Quote;
};

export type HostedPayment = {
  paymentId: string;
  checkoutUrl: string;
  amountCents: number;
  currency: string;
};

export type PaymentSnapshot = ApprovedQuote & {
  status: PaymentStatus;
  payment: HostedPayment;
  updatedAt: number;
  failureReason?: 'declined' | 'expired' | 'unavailable';
  card: { status: 'unsupported' } | { status: 'available'; brand: string; last4: string } | null;
};

export type AccountBalance = {
  availableCents: number;
  pendingCents: number;
  currency: string;
  kycRequired: boolean;
};

export type OrderStages = {
  paymentConfirmedAt: number | null;
  orderPlacedAt: number | null;
  shipmentAt: number | null;
};

export const paymentCopy: Record<PaymentStatus, { title: string; detail: string }> = {
  awaiting_payment: { title: 'Awaiting payment', detail: 'Confirmation can take a moment. We’ll check for a secure payment update; closing checkout does not cancel a payment.' },
  paid: { title: 'Payment confirmed', detail: 'Your payment is confirmed. The retailer’s order confirmation is a separate step.' },
  failed: { title: 'Payment failed', detail: 'The payment provider reported a failure. No charge will be retried automatically.' },
  cancelled: { title: 'Payment cancelled', detail: 'The payment provider confirmed this checkout was cancelled.' },
  abandoned: { title: 'Checkout abandoned', detail: 'The payment provider marked this checkout as abandoned.' },
  refunded: { title: 'Payment refunded', detail: 'The provider confirmed a refund. Your bank may take time to make it available.' },
  unknown: { title: 'Payment outcome unconfirmed', detail: 'A charge may have occurred. Refresh the status or contact support with the payment reference before trying another payment.' },
};

export const failureCopy = {
  declined: 'The provider declined the payment.',
  expired: 'The provider reported that checkout expired.',
  unavailable: 'The provider could not complete the payment.',
};

export function sameApproval(a: ApprovedQuote, b: ApprovedQuote): boolean {
  const terms = ({ requestId, quoteVersion, quote }: ApprovedQuote) => JSON.stringify([
    requestId, quoteVersion, quote.retailer, quote.seller, quote.productTitle, quote.variantLabel,
    quote.quantity, quote.unitPriceCents, quote.subtotalCents, quote.taxCents, quote.shippingCents,
    quote.totalCents, quote.currency, quote.deliveryEstimate, quote.returnSummary,
  ]);
  return terms(a) === terms(b);
}

export function spendableCents(balance: AccountBalance): number {
  return balance.availableCents;
}

export function maskedCard(card: PaymentSnapshot['card']): string | null {
  if (!card || card.status !== 'available' || !/^\d{4}$/.test(card.last4)) return null;
  const brand = /^(visa|mastercard|amex|discover)$/i.test(card.brand) ? card.brand : 'Card';
  return `${brand} •••• ${card.last4}`;
}
