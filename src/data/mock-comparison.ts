import type { CartItem, PriceComparison } from './types';

/**
 * Stand-in for CartItem.comparison while the deployed getItem predates it (the field is absent, not
 * null). Only the hero XM5 has a demo comparison; every other item gets none, so no price is invented.
 */
export function mockComparison(item: CartItem): PriceComparison | null {
  if (!item.product?.title.includes('WH-1000XM5')) return null;
  const checkedAt = item.addedAt + 60_000;
  const query = encodeURIComponent(item.product.title);
  return {
    status: 'completed',
    checkedAt,
    subjectUrl: item.url,
    exaRunId: null,
    note: null,
    offers: [
      {
        retailer: 'Walmart',
        seller: 'Video & Audio Center',
        productUrl: `https://www.walmart.com/search?q=${query}`,
        matchedIdentifier: null,
        condition: 'New',
        priceCents: 28800,
        currency: 'USD',
        availability: 'In Stock',
        shippingCents: null,
        checkedAt,
        reportedBy: 'exa',
        supportingSource: null,
      },
      {
        retailer: 'B&H',
        seller: 'B&H Photo',
        productUrl: `https://www.bhphotovideo.com/c/search?q=${query}`,
        matchedIdentifier: null,
        condition: 'New',
        priceCents: 29800,
        currency: 'USD',
        availability: 'In Stock',
        shippingCents: null,
        checkedAt,
        reportedBy: 'exa',
        supportingSource: null,
      },
    ],
    rejected: [{ retailer: 'Adorama', productUrl: `https://www.adorama.com/l/?searchinfo=${query}`, reason: "Couldn't verify listing" }],
  };
}
