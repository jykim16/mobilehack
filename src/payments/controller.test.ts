import { describe, expect, it, vi } from 'vitest';

import { paymentCapability, type PaymentCapability } from './adapter';
import { createPaymentController } from './controller';
import { fixtureApproval, fixtureBalance, fixturePayment } from './fixtures';
import { maskedCard, paymentCopy, sameApproval, spendableCents, type PaymentSnapshot, type PaymentStatus } from './model';

function setup(snapshot: PaymentSnapshot = fixturePayment) {
  let current = snapshot;
  const read = vi.fn(async (_requestId: string) => current);
  const browser = vi.fn(async (_url: string): Promise<unknown> => ({ type: 'success', url: 'cart://return?paid=true' }));
  const capability: PaymentCapability = { available: true, reader: { readByRequestId: read, checkoutOrigins: ['https://checkout.example.test'] } };
  const controller = createPaymentController(fixtureApproval.requestId, capability, browser);
  return { controller, read, browser, capability, getView: controller.getSnapshot, setSnapshot: (next: PaymentSnapshot) => { current = next; } };
}

describe('read-only hosted payment coordinator', () => {
  it('never interprets a browser return URL or success result as payment success', async () => {
    const test = setup();
    await test.controller.open(fixtureApproval);
    expect(test.browser).toHaveBeenCalledOnce();
    expect(test.read).toHaveBeenCalledTimes(2);
    expect(test.getView().snapshot?.status).toBe('awaiting_payment');
  });

  it.each(['cancel', 'dismiss'])('does not turn browser %s into a cancelled payment', async (type) => {
    const test = setup();
    test.browser.mockResolvedValue({ type });
    await test.controller.open(fixtureApproval);
    expect(test.getView().snapshot?.status).toBe('awaiting_payment');
  });

  it('uses the authoritative status after the browser closes', async () => {
    const test = setup();
    test.browser.mockImplementation(async () => test.setSnapshot({ ...fixturePayment, status: 'paid' }));
    await test.controller.open(fixtureApproval);
    expect(test.getView().snapshot?.status).toBe('paid');
  });

  it.each([
    { ...fixturePayment, quoteVersion: 4 },
    { ...fixturePayment, quote: { ...fixturePayment.quote, seller: 'Different seller' } },
    { ...fixturePayment, quote: { ...fixturePayment.quote, deliveryEstimate: 'Next month' } },
    { ...fixturePayment, payment: { ...fixturePayment.payment, amountCents: 12961 } },
  ])('requires fresh approval for changed terms or amount', async (snapshot) => {
    const test = setup(snapshot);
    await test.controller.open(fixtureApproval);
    expect(test.browser).not.toHaveBeenCalled();
    expect(test.getView().error).toContain('approve again');
    expect(test.read).toHaveBeenCalledOnce();
  });

  it('coalesces repeat taps and recovers the same payment after relaunch without any write API', async () => {
    const test = setup();
    await Promise.all([test.controller.open(fixtureApproval), test.controller.open(fixtureApproval)]);
    expect(test.browser).toHaveBeenCalledOnce();
    const relaunched = createPaymentController(fixtureApproval.requestId, test.capability, test.browser);
    expect((await relaunched.refresh())?.payment.paymentId).toBe(fixturePayment.payment.paymentId);
    expect(test.read.mock.calls.every(([requestId]) => requestId === fixtureApproval.requestId)).toBe(true);
    expect(Object.keys(test.capability.available && test.capability.reader)).toEqual(['readByRequestId', 'checkoutOrigins']);
    expect(test.browser).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'refunded', 'cancelled', 'abandoned', 'failed', 'paid'] as PaymentStatus[])('does not reopen checkout in %s state', async (status) => {
    const test = setup({ ...fixturePayment, status });
    await test.controller.open(fixtureApproval);
    expect(test.browser).not.toHaveBeenCalled();
    expect(test.getView().snapshot?.status).toBe(status);
  });

  it('marks stale cached status unknown after a read error without retrying the charge', async () => {
    const test = setup();
    await test.controller.refresh();
    test.read.mockRejectedValueOnce(new Error('private provider diagnostics'));
    await test.controller.refresh();
    expect(test.getView().snapshot?.status).toBe('unknown');
    expect(test.getView().error).not.toContain('private');
    expect(test.browser).not.toHaveBeenCalled();
  });

  it('still refreshes after a browser failure', async () => {
    const test = setup();
    test.browser.mockRejectedValue(new Error('cannot open'));
    await test.controller.open(fixtureApproval);
    expect(test.read).toHaveBeenCalledTimes(2);
    expect(test.getView().error).toContain('Refresh');
  });

  it.each(['http://checkout.example.test/pay', 'https://evil.test/pay', 'https://user:secret@checkout.example.test/pay'])('rejects unsafe checkout URLs', async (checkoutUrl) => {
    const test = setup({ ...fixturePayment, payment: { ...fixturePayment.payment, checkoutUrl } });
    await test.controller.open(fixtureApproval);
    expect(test.browser).not.toHaveBeenCalled();
  });

  it('is disabled by default and never reads or opens a browser', async () => {
    const browser = vi.fn();
    const controller = createPaymentController('request', paymentCapability, browser);
    expect(await controller.refresh()).toBeNull();
    await controller.open(fixtureApproval);
    expect(browser).not.toHaveBeenCalled();
    expect(paymentCapability.available).toBe(false);
  });
});

describe('payment view models', () => {
  it('keeps unknown, refunded, cancelled, and abandoned copy distinct', () => {
    expect(new Set(Object.values(paymentCopy).map(({ title }) => title)).size).toBe(7);
    expect(paymentCopy.unknown.detail).toContain('A charge may have occurred');
  });
  it('never counts pending funds as spendable', () => {
    expect(spendableCents(fixtureBalance)).toBe(4500);
    expect(spendableCents({ ...fixtureBalance, availableCents: 0 })).toBe(0);
  });
  it('shows only validated masked card data', () => {
    expect(maskedCard({ status: 'unsupported' })).toBeNull();
    expect(maskedCard({ status: 'available', brand: 'Visa', last4: '1234' })).toBe('Visa •••• 1234');
    expect(maskedCard({ status: 'available', brand: 'Visa', last4: '4111111111111111' })).toBeNull();
  });
  it('binds approval to the request and every material term', () => {
    expect(sameApproval(fixtureApproval, { ...fixtureApproval, requestId: 'other' })).toBe(false);
    expect(sameApproval(fixtureApproval, { ...fixtureApproval, quote: { ...fixtureApproval.quote, quantity: 2 } })).toBe(false);
  });
});
