import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { BalanceCard, OrderProgress, PaymentStatusCard, QuoteApproval } from './components';
import { fixtureApproval, fixtureBalance, fixturePayment, fixtureStages } from './fixtures';
import { paymentCopy, type PaymentStatus } from './model';

vi.mock('@/components/pill-button', () => ({
  PillButton: ({ label, disabled }: { label: string; disabled?: boolean }) => createElement('button', { disabled }, label),
}));

describe('payment presentation fixtures', () => {
  it.each(Object.keys(paymentCopy) as PaymentStatus[])('renders the distinct %s state', (status) => {
    const html = renderToStaticMarkup(createElement(PaymentStatusCard, { view: { snapshot: { ...fixturePayment, status }, busy: false, error: null }, onRefresh: () => {} }));
    expect(html).toContain(paymentCopy[status].title);
    expect(html).toContain('Simulated card / Sandbox retailer charge');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('4242');
    expect(html).not.toContain('Market St');
  });

  it('has an accessible pending/error state and refresh action, not a retry-charge action', () => {
    const html = renderToStaticMarkup(createElement(PaymentStatusCard, { view: { snapshot: null, busy: true, error: 'Outcome unconfirmed' }, onRefresh: () => {} }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('Refresh payment status');
    expect(html).not.toContain('Retry payment');
  });

  it('keeps payment confirmation separate from order placement and shipment', () => {
    const html = renderToStaticMarkup(createElement(OrderProgress, { stages: fixtureStages }));
    expect(html).toContain('Payment confirmed');
    expect(html).toContain('Simulated retailer order placed');
    expect(html).toContain('Simulated shipment');
    expect(html).toContain('Awaiting retailer confirmation');
    expect(html).toContain('Awaiting shipment update');
    expect(html).not.toContain('Awaiting payment confirmation');
  });

  it('renders pending money as unavailable and explains KYC without inventing a withdrawal', () => {
    const html = renderToStaticMarkup(createElement(BalanceCard, { balance: fixtureBalance }));
    expect(html).toContain('$45.00');
    expect(html).toContain('$129.60');
    expect(html).toContain('Pending funds are not available to spend');
    expect(html).toContain('Identity verification is required before withdrawal');
    expect(html).toContain('These funds may be shared');
    expect(html).not.toContain('<button');
  });

  it('preserves negative available and unknown pending without claiming ownership', () => {
    const html = renderToStaticMarkup(createElement(BalanceCard, { balance: { ...fixtureBalance, availableCents: -275, pendingCents: null } }));
    expect(html).toContain('-$2.75');
    expect(html).toContain('Unknown');
    expect(html).not.toContain('$0.00');
    expect(html).toContain('not confirmed as yours to spend');
  });

  it('keeps an unknown retailer outcome distinct from an ordinary wait', () => {
    const html = renderToStaticMarkup(createElement(OrderProgress, { stages: { ...fixtureStages, orderStatus: 'unknown' } }));
    expect(html).toContain('Order outcome unconfirmed');
    expect(html).toContain('do not retry');
  });

  it('shows the exact quote terms without any native card entry', () => {
    const html = renderToStaticMarkup(createElement(QuoteApproval, { approval: fixtureApproval, busy: false, onApprove: () => {} }));
    expect(html).toContain('Everyday headphones');
    expect(html).toContain('quote 3');
    expect(html).toContain('Approve and open secure checkout');
    expect(html).not.toContain('<input');
  });
});
