import type { PaymentSnapshot } from './model';

export type PaymentReader = {
  readByRequestId: (requestId: string) => Promise<PaymentSnapshot | null>;
  checkoutOrigins: readonly string[];
};

export type PaymentCapability =
  | { available: false; reason: string }
  | { available: true; reader: PaymentReader };

export const paymentCapability: PaymentCapability = {
  available: false,
  reason: 'Hosted payments are not connected. The live payment contract is not yet available.',
};
