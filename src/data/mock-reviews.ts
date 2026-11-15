import { DAY } from './mock-catalog';
import type { CartItem, Offer, Review, ReviewList, ReviewSource } from './types';

/**
 * Stand-in for reviews:list until the backend deploys it. Same shape: newest first, with per-source
 * row counts and average rating in bySource. Retailer reviews come from the item's own offers; the
 * rest are Reddit, X, and YouTube. Every row is simulated, and links open a search for that source.
 */

interface Seed {
  source: 'retailer' | 'reddit' | 'x' | 'youtube';
  author: string;
  text: string;
  rating?: number;
  score?: number;
  daysAgo: number;
}

const heroSeeds: Seed[] = [
  { source: 'reddit', author: 'u/lowfreqlarry · r/headphones', score: 214, daysAgo: 3, text: "Upgraded from the XM4s last month. Noise cancelling is a small step up, mostly in the mids, but the real difference is call quality. The folding hinge is gone, so the case is bigger than you'd think." },
  { source: 'retailer', author: 'Priya K.', rating: 5, daysAgo: 5, text: 'Wore these on a 14-hour flight to Singapore and forgot they were on. Battery was still at 40% when we landed. The touch controls take a day to learn.' },
  { source: 'x', author: '@gadgetgwen', score: 1240, daysAgo: 6, text: 'XM5 vs AirPods Max after two weeks: Sony wins on comfort and battery, Apple wins on build. If you fly a lot, get the Sony.' },
  { source: 'youtube', author: 'SoundCheck Weekly', score: 18400, daysAgo: 9, text: 'Full review: the best all-rounder at this price for travel. Bass is slightly boosted out of the box, and the app EQ fixes it in about a minute.' },
  { source: 'retailer', author: 'Marcus T.', rating: 4, daysAgo: 12, text: 'Great noise cancelling and a warm sound. Docked a star because they get warm on my ears after about three hours.' },
  { source: 'reddit', author: 'u/carryon_only · r/onebag', score: 87, daysAgo: 15, text: 'Bought these for long-haul work trips. They kill engine drone completely, but wind noise on the street is still noticeable. Wired mode with an airplane adapter works fine.' },
  { source: 'retailer', author: 'Dan R.', rating: 3, daysAgo: 20, text: 'Sound is excellent, but multipoint drops my laptop every few days. The last firmware update helped a bit.' },
  { source: 'x', author: '@nomadnina', score: 342, daysAgo: 24, text: 'Packing list staple now: Sony XM5 plus a cheap airplane adapter. Nothing else comes close for red-eyes.' },
  { source: 'retailer', author: 'Alicia W.', rating: 5, daysAgo: 31, text: 'Returned my Bose for these. Lighter, a better app, and speak-to-chat is actually useful at the office.' },
  { source: 'reddit', author: 'u/planar_pete · r/headphones', score: 56, daysAgo: 40, text: 'Good headphones, but for pure sound quality at home I still reach for my wired set. These are a travel tool first.' },
];

const genericSeeds: Seed[] = [
  { source: 'retailer', author: 'Jordan M.', rating: 5, daysAgo: 2, text: 'Exactly as described and arrived a day early. The quality feels better than the price suggests.' },
  { source: 'reddit', author: 'u/keeps_receipts · r/BuyItForLife', score: 132, daysAgo: 4, text: 'Had mine for about eight months of daily use. Still holds up, no complaints apart from the packaging being excessive.' },
  { source: 'x', author: '@dealwatcher', score: 410, daysAgo: 7, text: 'Finally bought this after watching the price for weeks. Worth it.' },
  { source: 'retailer', author: 'Sam P.', rating: 4, daysAgo: 10, text: "Solid overall. Setup took a few minutes longer than expected, but it's been reliable since." },
  { source: 'youtube', author: 'Gear Notes', score: 21000, daysAgo: 14, text: "Long-term test: what holds up, what doesn't, and whether it's worth full price. Short answer: wait for a sale, then buy it." },
  { source: 'retailer', author: 'Chris L.', rating: 2, daysAgo: 19, text: 'Mine had a defect out of the box. The replacement has been fine, but the return took a week.' },
  { source: 'reddit', author: 'u/pricechart · r/deals', score: 64, daysAgo: 26, text: "Price history says it dips every few weeks, so don't pay full price." },
  { source: 'retailer', author: 'Taylor R.', rating: 5, daysAgo: 33, text: "Second one I've bought, this time as a gift. Still recommend it." },
];

const retailerSource = (offer: Offer): ReviewSource =>
  offer.retailer === 'amazon' || offer.retailer === 'bestbuy' ? offer.retailer : 'other';

export function mockReviews(item: CartItem): ReviewList {
  const title = item.product?.title ?? 'this product';
  const query = encodeURIComponent(title);
  const offers = item.offers.length ? item.offers : item.offer ? [item.offer] : [];
  const seeds = title.includes('WH-1000XM5') ? heroSeeds : genericSeeds;
  const now = Date.now();
  let retailerIndex = 0;

  const reviews: Review[] = seeds.flatMap((seed, index): Review[] => {
    const base = {
      id: `mock-${item.id}-${index}`,
      author: seed.author,
      text: seed.text,
      rating: seed.rating ?? null,
      score: seed.score ?? null,
      postedAt: now - seed.daysAgo * DAY,
      simulated: true,
    };
    switch (seed.source) {
      case 'retailer': {
        const offer = offers[retailerIndex++ % Math.max(offers.length, 1)];
        if (!offer) return [];
        return [{ ...base, source: retailerSource(offer), sourceName: offer.retailerName, url: offer.url }];
      }
      case 'reddit':
        return [{ ...base, source: 'reddit', sourceName: 'Reddit', url: `https://www.reddit.com/search/?q=${query}` }];
      case 'x':
        return [{ ...base, source: 'x', sourceName: 'X', url: `https://x.com/search?q=${query}` }];
      case 'youtube':
        return [{ ...base, source: 'youtube', sourceName: 'YouTube', url: `https://www.youtube.com/results?search_query=${query}` }];
    }
  });

  const bySource: ReviewList['bySource'] = [];
  for (const review of reviews) {
    const entry = bySource.find((e) => e.source === review.source);
    if (entry) entry.count += 1;
    else bySource.push({ source: review.source, count: 1, average: null });
  }
  for (const entry of bySource) {
    const ratings = reviews.filter((r) => r.source === entry.source && r.rating !== null).map((r) => r.rating!);
    if (ratings.length) entry.average = Math.round((ratings.reduce((sum, n) => sum + n, 0) / ratings.length) * 10) / 10;
  }

  return { reviews, bySource };
}
