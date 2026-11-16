import type { AccountBalance, ApprovedQuote, OrderStages, PaymentSnapshot } from './model';
import { providerBalance, type WhopAccountPayload } from './whop-adapter';

export const fixtureApproval: ApprovedQuote = {
  requestId: 'fixture-request',
  quoteVersion: 3,
  quote: {
    retailer: 'demo', retailerName: 'Demo retailer', seller: 'Demo retailer', productTitle: 'Everyday headphones',
    variantLabel: 'Midnight', imageUrl: null, quantity: 1, unitPriceCents: 12000, subtotalCents: 12000,
    taxCents: 960, shippingCents: 0, totalCents: 12960, currency: 'USD', deliveryEstimate: 'Arrives Nov 19–21',
    returnSummary: 'Free returns within 30 days.', quotedAt: 1794787200000, simulated: true,
  },
};

export const fixturePayment: PaymentSnapshot = {
  ...fixtureApproval,
  status: 'awaiting_payment',
  payment: { paymentId: 'fixture-payment', checkoutUrl: 'https://checkout.example.test/fixture', amountCents: 12960, currency: 'USD' },
  updatedAt: 1794787500000,
  sandbox: true,
  card: { status: 'simulated', last4: '0000' },
};

export const fixtureAccount: WhopAccountPayload = {
  exists: true, environment: 'sandbox', mode: 'whop_sandbox',
  capabilities: { paymentCollection: 'whop', cardIssuance: 'simulated', cardCharges: 'simulated', retailerOrdering: 'simulated', cardNumbersExposed: false },
  kycRequired: true,
  providerBalance: { availableCents: 4500, pendingCents: 12960, currency: 'USD', fetchedAt: 1794787500000 },
  card: { status: 'unsupported', maskedCard: '•••• 0000', last4: '0000', simulated: true },
};
export const fixtureBalance: AccountBalance = providerBalance(fixtureAccount);
export const fixtureStages: OrderStages = { paymentConfirmedAt: 1794787500000, orderPlacedAt: null, shipmentAt: null, simulated: true, orderStatus: 'awaiting_client' };
