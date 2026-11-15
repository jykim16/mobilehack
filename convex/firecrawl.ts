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

const GUIDANCE_SCHEMA = {
  type: "object",
  properties: {
    category: { type: ["string", "null"], description: "Product category, e.g. wireless over-ear headphones" },
    criteria: {
      type: "array",
      description: "Four buying criteria that matter for this category, one of them something shoppers usually forget",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          detail: { type: ["string", "null"], description: "What the page or category shows about this criterion" },
          whyItMatters: { type: ["string", "null"], description: "Why a shopper should care" },
          tone: { type: ["string", "null"], description: "positive, negative, neutral" },
          overlooked: { type: ["boolean", "null"], description: "True for the criterion shoppers rarely think to ask about" },
        },
        required: ["label"],
      },
    },
    evidence: { type: ["string", "null"], description: "A short snippet from the page supporting the criteria" },
  },
  required: ["category", "criteria"],
} as const;

const GUIDANCE_PROMPT =
  "Read this product page and list the buying criteria that actually matter for its category: build quality, compatibility, " +
  "comfort or handling, longevity, and anything the listing implies. Include exactly one criterion that shoppers usually " +
  "do not think to ask about (mark overlooked: true) - for instance whether it works wired, what accessories are required, " +
  "or how it behaves in the situation the buyer described. Use only what the page states; return null instead of guessing.";

/** Category guidance from the live page, for products we hold no seeded research for. */
export const extractGuidance = internalAction({
  args: { url: v.string() },
  returns: v.object({
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    category: v.union(v.string(), v.null()),
    evidence: v.union(v.string(), v.null()),
    criteria: v.array(
      v.object({
        label: v.string(),
        detail: v.union(v.string(), v.null()),
        whyItMatters: v.union(v.string(), v.null()),
        tone: v.union(v.string(), v.null()),
        overlooked: v.union(v.boolean(), v.null()),
      }),
    ),
  }),
  handler: async (_ctx, { url }) => {
    const key = env.FIRECRAWL_API_KEY;
    if (!key) return { ok: false, error: "FIRECRAWL_API_KEY is not set", category: null, evidence: null, criteria: [] };
    const result = await scrapeJson(url, GUIDANCE_SCHEMA, GUIDANCE_PROMPT, key);
    if (!result.ok) return { ok: false, error: result.error, category: null, evidence: null, criteria: [] };
    const raw = result.json as any;
    const criteria = Array.isArray(raw.criteria)
      ? raw.criteria.slice(0, 5).map((c: any) => ({
          label: String(c?.label ?? "Criterion"),
          detail: typeof c?.detail === "string" ? c.detail : null,
          whyItMatters: typeof c?.whyItMatters === "string" ? c.whyItMatters : null,
          tone: typeof c?.tone === "string" ? c.tone : null,
          overlooked: typeof c?.overlooked === "boolean" ? c.overlooked : null,
        }))
      : [];
    return {
      ok: true,
      error: null,
      category: typeof raw.category === "string" ? raw.category : null,
      evidence: typeof raw.evidence === "string" ? raw.evidence : null,
      criteria,
    };
  },
});
