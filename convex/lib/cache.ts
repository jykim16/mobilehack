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

const STOPWORDS = ["the", "and", "with", "for", "wireless"];

function titleWords(title: string): string[] {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STOPWORDS.includes(w));
}

/**
 * Product identity from a title. Single-character numbers are kept: "Pixel 8 Pro"
 * and "Pixel 9 Pro" must not collide, or one model's prices and threads appear
 * under the other.
 */
export function modelKey(title: string): string {
  const words = titleWords(title).filter((w) => w.length > 1 || /\d/.test(w));
  return words.slice(0, 8).join("-") || "unknown";
}

/** The full identity a cached payload belongs to, checked before it is reused. */
export function identityOf(title: string): string {
  return titleWords(title).join("-") || "unknown";
}

export function describeAge(fetchedAt: number, now = Date.now()): string {
  const minutes = Math.round((now - fetchedAt) / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
