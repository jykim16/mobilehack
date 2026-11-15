/**
 * Keepa is addressed by marketplace domain code plus ASIN, so the market comes
 * from the hostname the shopper submitted and the ASIN from the product URL.
 */
export const KEEPA_DOMAINS: Record<string, number> = {
  "amazon.com": 1,
  "amazon.co.uk": 2,
  "amazon.de": 3,
  "amazon.fr": 4,
  "amazon.co.jp": 5,
  "amazon.ca": 6,
  "amazon.cn": 7,
  "amazon.it": 8,
  "amazon.es": 9,
  "amazon.in": 10,
  "amazon.com.mx": 11,
  "amazon.com.br": 12,
  "amazon.com.au": 13,
};

/** Keepa timestamps are minutes since 2011-01-01T00:00:00Z, offset by 21,564,000. */
export const KEEPA_TIME_OFFSET_MINUTES = 21_564_000;

export function keepaDomain(hostname: string): number | null {
  const host = hostname.replace(/^www\./i, "").toLowerCase();
  return KEEPA_DOMAINS[host] ?? null;
}

export function keepaProductUrl(hostname: string, asin: string): string | null {
  const domain = keepaDomain(hostname);
  return domain === null ? null : `https://keepa.com/product/${domain}-${asin}`;
}

export function keepaTimeToMs(minutes: number): number | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return (minutes + KEEPA_TIME_OFFSET_MINUTES) * 60_000;
}

export type HistoryPoint = { at: number | null; priceCents: number };

/** Keepa series values are [keepaTimeMinutes, priceInCents]; -1 means no data. */
export function pointsFromSeries(data: unknown, limit = 120): HistoryPoint[] {
  if (!Array.isArray(data)) return [];
  const points: HistoryPoint[] = [];
  for (const entry of data) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [t, price] = entry as [unknown, unknown];
    if (typeof price !== "number" || price <= 0) continue;
    points.push({ at: typeof t === "number" ? keepaTimeToMs(t) : null, priceCents: Math.round(price) });
  }
  return points.slice(-limit);
}
