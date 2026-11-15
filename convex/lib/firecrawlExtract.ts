/**
 * JSON-schema shapes sent to Firecrawl scrapes and the parsers that turn the
 * answer into our offer shape. Every extracted field is nullable: when the page
 * does not state something we keep null rather than guessing.
 */

export const OFFER_SCHEMA = {
  type: "object",
  properties: {
    model: { type: ["string", "null"], description: "Product model or title as shown on the page" },
    variant: { type: ["string", "null"], description: "Colour, size or configuration shown for this offer" },
    retailer: { type: ["string", "null"], description: "Retailer name" },
    seller: { type: ["string", "null"], description: "Who sells or ships this specific offer" },
    condition: {
      type: ["string", "null"],
      description:
        "The condition of this exact offer as the page states it. Report \"New\" whenever the page sells a new item, " +
        "even if the word only appears in a condition row. Use null only when the page states no condition at all.",
    },
    displayedPrice: { type: ["number", "null"], description: "The price shown for this offer, in the page currency" },
    currency: { type: ["string", "null"], description: "ISO currency code" },
    availability: { type: ["string", "null"], description: "In stock, out of stock, or the stated availability text" },
    starRating: { type: ["number", "null"], description: "Average star rating out of 5" },
    ratingCount: { type: ["number", "null"], description: "Number of ratings behind the star rating" },
    asinOrSku: { type: ["string", "null"], description: "ASIN for Amazon, SKU or item id for other retailers" },
    imageUrl: {
      type: ["string", "null"],
      description: "URL of the listing's main product image, absolute or relative to the page",
    },
    evidence: { type: ["string", "null"], description: "Short verbatim snippet from the page that supports the price and seller" },
  },
  required: ["model", "seller", "displayedPrice", "evidence"],
} as const;

export const RETURN_TERMS_SCHEMA = {
  type: "object",
  properties: {
    windowDays: { type: ["number", "null"], description: "Return window in days as stated in the policy" },
    freeReturns: { type: ["boolean", "null"], description: "Whether return shipping is free" },
    openedItemRestrictions: { type: ["string", "null"], description: "Restrictions that apply once the item is opened" },
    appliesTo: { type: ["string", "null"], description: "Whether this policy covers this specific offer or every item the store sells" },
    evidence: { type: ["string", "null"], description: "Short verbatim snippet from the policy page" },
  },
  required: ["windowDays", "evidence"],
} as const;

export const OFFER_PROMPT =
  "Extract the single purchasable offer shown on this product page: the Buy Box offer, or the best available offer " +
  "when there is no Buy Box. Use only values printed on the page. Always state the offer's condition explicitly - " +
  "\"New\" for a new item, or the used/refurbished wording the page uses - and use null only when the page never " +
  "mentions condition. If the page shows no price for this exact variant, return null for displayedPrice. " +
  "Quote the snippet that supports the price, seller and condition in evidence.";

export const RETURN_PROMPT =
  "Extract the store's return policy: the return window in days, whether return shipping is free, " +
  "restrictions for opened items, and whether the policy covers the specific offer or the whole store. " +
  "Use only what the page states; return null when it is not stated. Quote the supporting sentence in evidence.";

export type RawExtraction = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value.replace(/[^0-9.]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower.startsWith("yes") || lower === "true") return true;
    if (lower.startsWith("no") || lower === "false") return false;
  }
  return null;
}

/** Relative image paths are resolved against the listing they came from. */
export function resolveImageUrl(imageUrl: string | null, listingUrl: string): string | null {
  if (!imageUrl) return null;
  try {
    return new URL(imageUrl, listingUrl).toString();
  } catch {
    return null;
  }
}

export type ExtractedOffer = {
  model: string | null;
  variant: string | null;
  retailer: string | null;
  seller: string | null;
  condition: string | null;
  priceCents: number | null;
  currency: string | null;
  availability: string | null;
  starRating: number | null;
  ratingCount: number | null;
  asinOrSku: string | null;
  imageUrl: string | null;
  evidence: string | null;
};

export function parseOffer(raw: RawExtraction): ExtractedOffer {
  const price = asNumber(raw.displayedPrice);
  const stars = asNumber(raw.starRating);
  const count = asNumber(raw.ratingCount);
  return {
    model: asString(raw.model),
    variant: asString(raw.variant),
    retailer: asString(raw.retailer),
    seller: asString(raw.seller),
    condition: asString(raw.condition),
    priceCents: price === null ? null : Math.round(price * 100),
    currency: asString(raw.currency)?.toUpperCase().slice(0, 3) ?? null,
    availability: asString(raw.availability),
    starRating: stars !== null && stars >= 0 && stars <= 5 ? Math.round(stars * 10) / 10 : null,
    ratingCount: count !== null && count >= 0 ? Math.round(count) : null,
    asinOrSku: asString(raw.asinOrSku),
    imageUrl: asString(raw.imageUrl),
    evidence: asString(raw.evidence),
  };
}

export type ExtractedReturnTerms = {
  windowDays: number | null;
  freeReturns: boolean | null;
  openedItemRestrictions: string | null;
  appliesTo: "offer" | "storewide" | null;
  evidence: string | null;
};

export function parseReturnTerms(raw: RawExtraction): ExtractedReturnTerms {
  const days = asNumber(raw.windowDays);
  const applies = asString(raw.appliesTo)?.toLowerCase() ?? null;
  return {
    windowDays: days !== null && days >= 0 ? Math.round(days) : null,
    freeReturns: asBoolean(raw.freeReturns),
    openedItemRestrictions: asString(raw.openedItemRestrictions),
    appliesTo: applies === null ? null : applies.includes("store") || applies.includes("all") ? "storewide" : "offer",
    evidence: asString(raw.evidence),
  };
}

/** The id we asked for (ASIN or SKU) appears in the URL we scraped, or in the extraction. */
/**
 * We scrape the exact product URL the shopper added, so that URL is the source
 * of truth. An extracted id only vetoes the extraction when it names a
 * different variant.
 */
export function sameVariant(expectedKey: string | null, extractedKey: string | null): boolean {
  if (expectedKey === null) return extractedKey === null;
  const want = expectedKey.split(":").pop()!.toUpperCase();
  // Retailers we cannot key by SKU fall back to a URL-shaped key
  // ("walmart:walmart.com/ip/Widget/123456"). There the scraped page is the
  // authority, so only a clearly different id vetoes the extraction.
  if (want.includes("/") || want.includes(".")) return true;
  if (extractedKey === null) return true;
  return extractedKey.toUpperCase().includes(want);
}
