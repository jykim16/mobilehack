/**
 * Demo checkout profile. The backend holds no payment or address data by design (api-contract.md),
 * so detail screens show this placeholder and label it "Demo".
 */

export type CardBrand = 'visa' | 'mastercard' | 'amex';

export const demoProfile = {
  card: { brand: 'visa' as CardBrand, last4: '4242', expires: '08/29' },
  address: {
    name: 'Demo Shopper',
    line1: '548 Market St',
    city: 'San Francisco',
    region: 'CA',
    postalCode: '94104',
  },
};
