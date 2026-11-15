// TTLs and cache keys. Volatility decides the window: a stale price is a lie, a
// stale image is just old, and an Exa comparison or search answer barely moves.
export const CACHE_TTL_MS = {
  offer: 15 * 60_000,
  comparison: 6 * 60 * 60_000,
  query: 24 * 60 * 60_000,
  reddit: 12 * 60 * 60_000,
} as const;

export type CacheKind = keyof typeof CACHE_TTL_MS;

/** Product-level fields stay usable far longer than the price they came with. */
export const PRODUCT_FIELD_TTL_MS = 24 * 60 * 60_000;

/** How long one in-flight upstream call is allowed to block a duplicate. */
export const SINGLE_FLIGHT_MS = 90_000;

export function normalizedQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Product identity from a title: brand and model words, order preserved. */
export function modelKey(title: string): string {
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !["the", "and", "with", "for", "wireless"].includes(w));
  return words.slice(0, 5).join("-") || "unknown";
}

export function describeAge(fetchedAt: number, now = Date.now()): string {
  const minutes = Math.round((now - fetchedAt) / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
