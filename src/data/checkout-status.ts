import type { Order } from './types';

export type CheckoutResult = 'placed' | 'placing' | 'payment_required' | 'unconfirmed' | 'failed' | 'requote_required';

export function checkoutResult(order: Order | null | undefined): CheckoutResult {
  if (order?.status === 'awaiting_payment') return 'payment_required';
  if (order?.status === 'submitting') return 'placing';
  if (order?.status === 'failed') return 'failed';
  if (order?.status === 'requote_required') return 'requote_required';
  if (order?.status !== 'placed' || order.placedAt === null || order.placedAt <= 0 || !Number.isFinite(order.placedAt)) return 'unconfirmed';
  const identifier = order.simulated ? order.orderRef : order.retailerOrderId;
  return identifier?.trim() ? 'placed' : 'unconfirmed';
}

export const checkoutMessages = {
  payment_required: 'Payment is required. No order has been placed. This item is still in your cart.',
  unconfirmed: 'Order not confirmed. Check its status before trying again.',
  failed: 'The order failed. No order placement was confirmed.',
  requote_required: 'The price changed. Review the item in your cart.',
};

export class CheckoutNotPlaced extends Error {
  readonly result: Exclude<CheckoutResult, 'placed' | 'placing'>;

  constructor(result: Exclude<CheckoutResult, 'placed' | 'placing'>) {
    super(checkoutMessages[result]);
    this.name = 'CheckoutNotPlaced';
    this.result = result;
  }
}
