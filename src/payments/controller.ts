import type { PaymentCapability } from './adapter';
import { sameApproval, type ApprovedQuote, type PaymentSnapshot } from './model';

export type PaymentView = {
  snapshot: PaymentSnapshot | null;
  busy: boolean;
  error: string | null;
};

export function createPaymentController(
  requestId: string,
  capability: PaymentCapability,
  openBrowser: (url: string) => Promise<unknown>,
) {
  let view: PaymentView = { snapshot: null, busy: false, error: null };
  const listeners = new Set<() => void>();
  let opening = false;
  let reading: Promise<PaymentSnapshot | null> | null = null;
  const publish = (patch: Partial<PaymentView>) => {
    view = { ...view, ...patch };
    listeners.forEach((listener) => listener());
  };

  function refresh(): Promise<PaymentSnapshot | null> {
    if (!capability.available) {
      publish({ error: capability.reason });
      return Promise.resolve(null);
    }
    if (reading) return reading;
    publish({ busy: true, error: null });
    reading = Promise.resolve().then(() => capability.reader.readByRequestId(requestId)).then((snapshot) => {
      if (snapshot && snapshot.requestId !== requestId) throw new Error('Mismatched request');
      publish({ snapshot, error: snapshot ? null : 'No payment is confirmed for this request. Contact support before starting another payment.' });
      return snapshot;
    }).catch(() => {
      publish({ snapshot: view.snapshot ? { ...view.snapshot, status: 'unknown' } : null, error: 'Payment outcome unconfirmed. Refresh or contact support before trying another payment.' });
      return null;
    }).finally(() => {
      reading = null;
      publish({ busy: opening });
    });
    return reading;
  }

  async function open(approval: ApprovedQuote) {
    if (opening || !capability.available) return;
    opening = true;
    const approved = { ...approval, quote: { ...approval.quote } };
    try {
      const snapshot = await refresh();
      if (!snapshot) return;
      if (!sameApproval(approved, snapshot) || snapshot.payment.amountCents !== approved.quote.totalCents || snapshot.payment.currency !== approved.quote.currency) {
        publish({ error: 'The quote changed. Review the updated terms and approve again before opening checkout.' });
        return;
      }
      if (snapshot.status !== 'awaiting_payment') return;
      if (!snapshot.payment.checkoutUrl) {
        publish({ error: 'Checkout is not available yet. Refresh the payment status.' });
        return;
      }
      const url = new URL(snapshot.payment.checkoutUrl);
      if (url.protocol !== 'https:' || url.username || url.password || !capability.reader.checkoutOrigins.includes(url.origin)) {
        publish({ error: 'Checkout is unavailable. Refresh or contact support.' });
        return;
      }
      try {
        await openBrowser(url.href);
      } finally {
        await refresh();
      }
    } catch {
      publish({ error: 'Checkout could not be opened. Refresh the payment status before trying again.' });
    } finally {
      opening = false;
      publish({ busy: false });
    }
  }

  return {
    refresh,
    open,
    getSnapshot: () => view,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
