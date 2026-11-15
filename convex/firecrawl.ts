import { v } from "convex/values";
import { env, internalAction } from "./_generated/server";
import {
  OFFER_PROMPT,
  OFFER_SCHEMA,
  RETURN_PROMPT,
  RETURN_TERMS_SCHEMA,
  parseOffer,
  parseReturnTerms,
  sameVariant,
  type RawExtraction,
} from "./lib/firecrawlExtract";

const FIRECRAWL_ENDPOINT = "https://api.firecrawl.dev/v2/scrape";

export type ScrapeResult =
  | { ok: true; json: RawExtraction; sourceUrl: string; title: string | null }
  | { ok: false; error: string; status?: number };

export async function scrapeJson(
  url: string,
  schema: unknown,
  prompt: string,
  apiKey: string,
): Promise<ScrapeResult> {
  let res: Response;
  try {
    res = await fetch(FIRECRAWL_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        onlyMainContent: true,
        formats: [{ type: "json", schema, prompt }],
      }),
    });
  } catch (e) {
    return { ok: false, error: `Firecrawl request failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const text = await res.text();
  if (!res.ok) {
    return { ok: false, status: res.status, error: `Firecrawl HTTP ${res.status}: ${text.slice(0, 300)}` };
  }
  let body: any;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, error: `Firecrawl returned non-JSON: ${text.slice(0, 300)}` };
  }
  const data = body?.data ?? body;
  const json = data?.json ?? data?.extract?.json ?? data?.extract ?? null;
  if (!json || typeof json !== "object") {
    return { ok: false, error: `Firecrawl returned no structured json: ${text.slice(0, 300)}` };
  }
  return {
    ok: true,
    json: json as RawExtraction,
    sourceUrl: typeof data?.metadata?.sourceURL === "string" ? data.metadata.sourceURL : url,
    title: typeof data?.metadata?.title === "string" ? data.metadata.title : null,
  };
}

/** Scrapes one product page into the offer shape. Never throws: callers fall back. */
export const extractOffer = internalAction({
  args: { url: v.string(), expectedKey: v.union(v.string(), v.null()) },
  returns: v.object({
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    offer: v.union(
      v.object({
        model: v.union(v.string(), v.null()),
        variant: v.union(v.string(), v.null()),
        retailer: v.union(v.string(), v.null()),
        seller: v.union(v.string(), v.null()),
        condition: v.union(v.string(), v.null()),
        priceCents: v.union(v.number(), v.null()),
        currency: v.union(v.string(), v.null()),
        availability: v.union(v.string(), v.null()),
        starRating: v.union(v.number(), v.null()),
        ratingCount: v.union(v.number(), v.null()),
        asinOrSku: v.union(v.string(), v.null()),
        evidence: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
    sourceUrl: v.union(v.string(), v.null()),
    variantMatches: v.boolean(),
  }),
  handler: async (_ctx, { url, expectedKey }) => {
    const key = env.FIRECRAWL_API_KEY;
    if (!key) {
      return { ok: false, error: "FIRECRAWL_API_KEY is not set on this deployment", offer: null, sourceUrl: null, variantMatches: false };
    }
    const result = await scrapeJson(url, OFFER_SCHEMA, OFFER_PROMPT, key);
    if (!result.ok) {
      console.warn("Firecrawl offer extraction failed", url, result.error);
      return { ok: false, error: result.error, offer: null, sourceUrl: null, variantMatches: false };
    }
    const offer = parseOffer(result.json);
    return {
      ok: true,
      error: null,
      offer,
      sourceUrl: result.sourceUrl,
      variantMatches: sameVariant(expectedKey, offer.asinOrSku),
    };
  },
});

export const extractReturnTerms = internalAction({
  args: { url: v.string() },
  returns: v.object({
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    terms: v.union(
      v.object({
        windowDays: v.union(v.number(), v.null()),
        freeReturns: v.union(v.boolean(), v.null()),
        openedItemRestrictions: v.union(v.string(), v.null()),
        appliesTo: v.union(v.literal("offer"), v.literal("storewide"), v.null()),
        evidence: v.union(v.string(), v.null()),
      }),
      v.null(),
    ),
    sourceUrl: v.union(v.string(), v.null()),
  }),
  handler: async (_ctx, { url }) => {
    const key = env.FIRECRAWL_API_KEY;
    if (!key) {
      return { ok: false, error: "FIRECRAWL_API_KEY is not set on this deployment", terms: null, sourceUrl: null };
    }
    const result = await scrapeJson(url, RETURN_TERMS_SCHEMA, RETURN_PROMPT, key);
    if (!result.ok) {
      console.warn("Firecrawl return-terms extraction failed", url, result.error);
      return { ok: false, error: result.error, terms: null, sourceUrl: null };
    }
    return { ok: true, error: null, terms: parseReturnTerms(result.json), sourceUrl: result.sourceUrl };
  },
});
