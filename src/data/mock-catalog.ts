import type { Offer, PricePoint, Product, Rating } from './types';

export const DAY = 24 * 60 * 60 * 1000;
export const TAX_RATE = 0.08266;

export function daysFromNow(days: number) {
  return Date.now() + days * DAY;
}

export function etaFromNow(days: number) {
  const d = new Date(daysFromNow(days));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekday(days: number) {
  return new Date(daysFromNow(days)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

interface Retailer {
  id: string;
  name: string;
  deliveryDays: number;
  returnDays: number;
}

const retailers: Record<string, Retailer> = {
  amazon: { id: 'amazon', name: 'Amazon', deliveryDays: 2, returnDays: 30 },
  bestbuy: { id: 'bestbuy', name: 'Best Buy', deliveryDays: 3, returnDays: 15 },
  nike: { id: 'nike', name: 'Nike', deliveryDays: 4, returnDays: 60 },
  target: { id: 'target', name: 'Target', deliveryDays: 3, returnDays: 90 },
  rei: { id: 'rei', name: 'REI', deliveryDays: 4, returnDays: 90 },
  walmart: { id: 'walmart', name: 'Walmart', deliveryDays: 3, returnDays: 30 },
};

export function returnSummaryFor(retailerId: string, deliveredAt?: number) {
  const { returnDays } = retailers[retailerId];
  if (deliveredAt === undefined) return `Free ${returnDays}-day returns`;
  const until = new Date(deliveredAt + returnDays * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `Free returns until ${until}`;
}

export function deliveryDaysFor(retailerId: string) {
  return retailers[retailerId].deliveryDays;
}

export interface CatalogEntry {
  product: Product;
  variant: { id: string; label: string };
  rating: Rating;
  offers: Offer[];
  history: Record<string, PricePoint[]>;
}

type OfferSeed = [retailerId: string, priceCents: number, listPriceCents: number | null, url: string, average: number, count: number];

function entry(
  product: Product,
  variantLabel: string,
  offerSeeds: OfferSeed[],
  historyOverride?: Record<string, number[]>
): CatalogEntry {
  const variant = { id: `${product.id}:${variantLabel.toLowerCase().replace(/\W+/g, '-')}`, label: variantLabel };
  const offers: Offer[] = offerSeeds.map(([retailerId, priceCents, listPriceCents, url, average, count]) => {
    const retailer = retailers[retailerId];
    return {
      id: `${product.id}@${retailerId}`,
      retailer: retailerId,
      retailerName: retailer.name,
      seller: retailer.name,
      url,
      variantId: variant.id,
      variantLabel,
      priceCents,
      listPriceCents,
      shippingCents: 0,
      currency: 'USD',
      deliveryEstimate: `Free delivery ${weekday(retailer.deliveryDays)}`,
      returnSummary: returnSummaryFor(retailerId),
      rating: { average, count },
      inStock: true,
      simulated: true,
      updatedAt: Date.now(),
    };
  });
  const retailerRatings = offers.map((o) => ({ retailerName: o.retailerName, average: o.rating!.average, count: o.rating!.count }));
  const count = retailerRatings.reduce((sum, r) => sum + r.count, 0);
  const average = Math.round((retailerRatings.reduce((sum, r) => sum + r.average * r.count, 0) / count) * 10) / 10;
  const history = Object.fromEntries(
    offers.map((o) => [o.id, historyPoints(o, historyOverride?.[o.retailer])])
  );
  return { product, variant, rating: { average, count, retailers: retailerRatings }, offers, history };
}

function historyPoints(offer: Offer, override?: number[]): PricePoint[] {
  const weeks = 13;
  let prices = override;
  if (!prices) {
    let seed = [...offer.id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const high = offer.listPriceCents ?? Math.round(offer.priceCents * 1.1);
    prices = Array.from({ length: weeks }, (_, i) => {
      if (i === 0) return high;
      if (i === weeks - 1) return offer.priceCents;
      const trend = high + (offer.priceCents - high) * (i / (weeks - 1)) ** 1.6;
      const noise = (random() - 0.5) * 0.06 * high;
      const dip = random() < 0.12 ? 0.9 : 1;
      return Math.round(Math.min(high, (trend + noise) * dip) / 100) * 100 - 1;
    });
  }
  return prices.map((priceCents, i) => ({
    observedAt: daysFromNow(-(prices.length - 1 - i) * 7),
    priceCents,
    source: offer.retailerName,
    simulated: true,
  }));
}

export const HERO_URL = 'https://www.amazon.com/dp/B09XS7JWHH';

export const catalog: CatalogEntry[] = [
  entry(
    {
      id: 'sony-wh1000xm5',
      title: 'Sony WH-1000XM5 Wireless Noise Canceling Headphones',
      brand: 'Sony',
      category: 'Headphones',
      imageUrl: 'asset:sony-headphones',
      description: null,
    },
    'Black',
    [
      ['amazon', 22999, 39999, HERO_URL, 4.4, 21480],
      ['bestbuy', 27999, 39999, 'https://www.bestbuy.com/site/6505727.p', 4.7, 6312],
      ['target', 29999, 39999, 'https://www.target.com/p/A-86615603', 4.5, 1840],
    ],
    { amazon: [29999, 29999, 27999, 27999, 28999, 27999, 27999, 27999, 26999, 27999, 27999, 27999, 22999] }
  ),
  entry(
    {
      id: 'airfly-pro',
      title: 'Twelve South AirFly Pro Wireless Audio Transmitter',
      brand: 'Twelve South',
      category: 'Travel audio',
      imageUrl: 'asset:airfly-pro',
      description: null,
    },
    'Black',
    [
      ['bestbuy', 4999, 5499, 'https://www.bestbuy.com/site/6449913.p', 4.5, 1120],
      ['amazon', 5499, null, 'https://www.amazon.com/dp/B07RGCSDRR', 4.3, 9870],
    ]
  ),
  entry(
    {
      id: 'soundcore-q45',
      title: 'Soundcore Space Q45 Adaptive Noise Cancelling Headphones',
      brand: 'Soundcore',
      category: 'Headphones',
      imageUrl: 'asset:soundcore-headphones',
      description: null,
    },
    'Navy',
    [
      ['amazon', 9999, 14999, 'https://www.amazon.com/dp/B0B5V7SDBX', 4.5, 14220],
      ['walmart', 10988, null, 'https://www.walmart.com/ip/1660387370', 4.3, 1180],
      ['bestbuy', 12999, 14999, 'https://www.bestbuy.com/site/6514640.p', 4.4, 512],
    ]
  ),
  entry(
    {
      id: 'nike-pegasus-41',
      title: "Nike Pegasus 41 Men's Road Running Shoes",
      brand: 'Nike',
      category: 'Running shoes',
      imageUrl: 'asset:running-shoe',
      description: null,
    },
    'Black/White · Size 10',
    [
      ['nike', 13999, null, 'https://www.nike.com/t/pegasus-41-FD2722-002', 4.6, 3410],
      ['rei', 13995, null, 'https://www.rei.com/product/240364', 4.5, 288],
      ['amazon', 14400, null, 'https://www.amazon.com/dp/B0D1Q8Y3M4', 4.4, 1902],
    ]
  ),
  entry(
    {
      id: 'breville-bambino-plus',
      title: 'Breville Bambino Plus Espresso Machine',
      brand: 'Breville',
      category: 'Espresso machines',
      imageUrl: 'asset:espresso-machine',
      description: null,
    },
    'Brushed Stainless Steel',
    [
      ['target', 39999, 49999, 'https://www.target.com/p/A-53524318', 4.5, 1322],
      ['amazon', 41995, 49999, 'https://www.amazon.com/dp/B07FDJMC9Q', 4.6, 7540],
      ['bestbuy', 49999, null, 'https://www.bestbuy.com/site/6295219.p', 4.7, 980],
    ]
  ),
  entry(
    {
      id: 'garmin-forerunner-265',
      title: 'Garmin Forerunner 265 GPS Running Smartwatch',
      brand: 'Garmin',
      category: 'Smartwatches',
      imageUrl: 'asset:gps-watch',
      description: null,
    },
    'Black · 46 mm',
    [
      ['rei', 34995, 44995, 'https://www.rei.com/product/219133', 4.7, 402],
      ['amazon', 36999, 44999, 'https://www.amazon.com/dp/B0BS1T9J4Y', 4.6, 5880],
      ['bestbuy', 39999, 44999, 'https://www.bestbuy.com/site/6533464.p', 4.7, 1210],
    ]
  ),
  entry(
    {
      id: 'galaxy-buds3-pro',
      title: 'Samsung Galaxy Buds3 Pro Wireless Earbuds',
      brand: 'Samsung',
      category: 'Earbuds',
      imageUrl: 'asset:earbuds',
      description: null,
    },
    'White',
    [
      ['walmart', 17900, 24999, 'https://www.walmart.com/ip/5089331512', 4.3, 2045],
      ['amazon', 18999, 24999, 'https://www.amazon.com/dp/B0D7HTD3VS', 4.2, 6330],
      ['bestbuy', 19999, 24999, 'https://www.bestbuy.com/site/6589326.p', 4.5, 3120],
    ]
  ),
];

export function findByUrl(url: string) {
  for (const e of catalog) {
    const offer = e.offers.find((o) => o.url === url);
    if (offer) return { entry: e, offer };
  }
  return null;
}

export function offerUrl(offerId: string) {
  for (const e of catalog) {
    const offer = e.offers.find((o) => o.id === offerId);
    if (offer) return offer.url;
  }
  throw new Error(`Unknown offer ${offerId}`);
}
