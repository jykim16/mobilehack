import { describe, expect, it } from 'vitest';

import { fixtureAccount, fixtureApproval, fixturePayment } from './fixtures';
import { isSandboxDemo, orderStages, paymentSnapshot, providerBalance, type WhopStatusPayload } from './whop-adapter';

const response: WhopStatusPayload = {
  requestStatus: 'approved', quoteVersion: 3, quoteTotalCents: 12960,
  payment: { ...fixturePayment.payment, status: 'pending', quoteVersion: 3, paidAt: null, failureReason: null },
  order: { status: 'awaiting_payment', placedAt: null, refundedAt: null },
};

describe('published Whop contract normalization without network access', () => {
  it('preserves negative and pending provider amounts instead of computing proceeds', () => {
    const balance = providerBalance({ ...fixtureAccount, providerBalance: { ...fixtureAccount.providerBalance!, availableCents: -275, pendingCents: 1850 } });
    expect(balance.availableCents).toBe(-275);
    expect(balance.pendingCents).toBe(1850);
    expect(balance.ownershipConfirmed).toBe(false);
  });

  it('preserves unknown balances, currency and freshness without falling back to a ledger', () => {
    expect(providerBalance({ ...fixtureAccount, providerBalance: null })).toEqual({
      availableCents: null, pendingCents: null, currency: null, fetchedAt: null, kycRequired: true, ownershipConfirmed: false,
    });
    expect(providerBalance({ ...fixtureAccount, providerBalance: { ...fixtureAccount.providerBalance!, availableCents: 0, pendingCents: null } }).availableCents).toBe(0);
  });

  it('requires explicit sandbox and simulated capabilities', () => {
    expect(isSandboxDemo(fixtureAccount)).toBe(true);
    expect(isSandboxDemo({ ...fixtureAccount, mode: null })).toBe(false);
    expect(isSandboxDemo({ ...fixtureAccount, capabilities: { ...fixtureAccount.capabilities, cardCharges: 'whop' } })).toBe(false);
  });

  it.each([
    ['pending', 'awaiting_payment'], ['succeeded', 'paid'], ['failed', 'failed'],
    ['refunded', 'refunded'], ['partially_refunded', 'partially_refunded'], ['disputed', 'disputed'], ['unrecognized', 'unknown'],
  ])('maps %s without collapsing it into success', (status, expected) => {
    expect(paymentSnapshot(fixtureApproval, { ...response, payment: { ...response.payment!, status } }, fixtureAccount)?.status).toBe(expected);
  });

  it('does not invent cancelled from the safe failure sentence or a browser return', () => {
    const snapshot = paymentSnapshot(fixtureApproval, { ...response, payment: { ...response.payment!, status: 'failed', failureReason: 'Checkout cancelled.' } }, fixtureAccount);
    expect(snapshot?.status).toBe('failed');
    expect(snapshot?.failureReason).toBe('Checkout cancelled.');
  });

  it('does not fabricate a checkout URL or update timestamp', () => {
    const snapshot = paymentSnapshot(fixtureApproval, { ...response, payment: { ...response.payment!, checkoutUrl: null } }, fixtureAccount);
    expect(snapshot?.payment.checkoutUrl).toBeNull();
    expect(snapshot?.updatedAt).toBeNull();
  });

  it('rejects stale quote bindings and never presents an unapproved request as payable', () => {
    expect(() => paymentSnapshot(fixtureApproval, { ...response, quoteVersion: 4 }, fixtureAccount)).toThrow('current quote');
    expect(paymentSnapshot(fixtureApproval, { ...response, requestStatus: 'pending_approval' }, fixtureAccount)?.status).toBe('unknown');
  });

  it('only accepts explicitly synthetic masked card details in the sandbox', () => {
    expect(paymentSnapshot(fixtureApproval, response, fixtureAccount)?.card).toEqual({ status: 'simulated', last4: '0000' });
    expect(paymentSnapshot(fixtureApproval, response, { ...fixtureAccount, card: { ...fixtureAccount.card!, simulated: false } })?.card).toBeNull();
    expect(paymentSnapshot(fixtureApproval, response, { ...fixtureAccount, card: { ...fixtureAccount.card!, maskedCard: null } })?.card).toEqual({ status: 'simulated', last4: null });
  });

  it('does not turn payment into order or shipment timestamps', () => {
    const payload = { ...response, payment: { ...response.payment!, status: 'succeeded', paidAt: 1000 } };
    expect(orderStages(payload, fixtureAccount, null)).toEqual({ paymentConfirmedAt: 1000, orderPlacedAt: null, shipmentAt: null, simulated: true, orderStatus: 'awaiting_payment' });
    expect(orderStages({ ...payload, order: { ...payload.order!, status: 'placed', placedAt: 2000 } }, fixtureAccount, { simulated: true, events: [{ status: 'shipped', occurredAt: 3000 }] })).toEqual({ paymentConfirmedAt: 1000, orderPlacedAt: 2000, shipmentAt: 3000, simulated: true, orderStatus: 'placed' });
  });
});
