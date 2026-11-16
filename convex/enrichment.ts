import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { env, type ActionCtx, type MutationCtx, type QueryCtx } from "./_generated/server";
import { SECTION_NAMES, sectionName, sectionStatus, highlight, source, type SectionName } from "./lib/validators";
import { describeAge } from "./lib/cache";
import { isFresh } from "./cache";
import {
  RETAILER_RETURN_TERMS,
  SEEDED_EVIDENCE,
  SEEDED_OFFER_EVIDENCE,
  type SectionResult,
} from "./lib/demoData";
import { fetchOpenGraph, titleFromUrl } from "./lib/opengraph";
import { canonicalKeyForUrl, retailerFromHost } from "./lib/urls";
import { keepaProductUrl } from "./lib/keepa";
import { classifyCondition, isWithheldCondition } from "./lib/conditions";
import { resolveImageUrl } from "./lib/firecrawlExtract";

const MAX_ATTEMPTS = 3;
/** Staggered so the demo shows sections filling in one by one. */
const SECTION_DELAY_MS: Record<SectionName, number> = {
  priceHistory: 1_000,
  categoryGuidance: 2_500,
  returnTerms: 3_500,
  retailerReviews: 5_000,
  reddit: 6_500,
};
const SECTION_SCOPE: Record<SectionName, "product" | "offer"> = {
  categoryGuidance: "product",
  returnTerms: "offer",
  priceHistory: "offer",
  retailerReviews: "offer",
  reddit: "product",
};


export const RETURN_POLICY_URLS: Record<string, string> = {
  amazon: "https://www.amazon.com/gp/help/customer/display.html?nodeId=GKM69DUUYKQWKWX7",
  bestbuy: "https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c",
};

/** Runs the Firecrawl offer + return-terms steps. No key means nothing happens. */
type CachedExtraction = {
  offer: {
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
  } | null;
  sourceUrl: string;
  observedAt: number;
  stale: boolean;
  note: string | null;
  error: string | null;
  variantMatches: boolean;
};

/**
 * One scrape per listing, shared by every shopper: a fresh cached extraction is
 * used as-is, a duplicate request during an in-flight scrape attaches to it, and a
 * refusal from upstream serves the last extraction we did read, marked stale with
 * the time it was read. Never invented numbers — an empty answer stays empty.
 */
async function extractWithCache(
  ctx: ActionCtx,
  url: string,
  canonicalKey: string,
  force: boolean,
): Promise<CachedExtraction> {
  const now = Date.now();
  const cached = await ctx.runQuery(internal.cache.read, { kind: "offer", key: canonicalKey });
  const stored = cached?.payload
    ? (JSON.parse(cached.payload) as { offer: CachedExtraction["offer"]; variantMatches: boolean })
    : null;
  const payload = stored?.offer ?? null;
  const variantMatches = stored?.variantMatches ?? true;
  const fresh = Boolean(payload) && !force && !cached!.invalidatedAt && isFresh("offer", cached!.fetchedAt, now);
  if (fresh) {
    return {
      offer: payload,
      sourceUrl: url,
      observedAt: cached!.fetchedAt,
      stale: false,
      note: null,
      error: null,
      variantMatches,
    };
  }

  const claim = await ctx.runMutation(internal.cache.claim, {
    kind: "offer",
    key: canonicalKey,
    source: "firecrawl",
  });
  if (!claim.claimed) {
    if (payload) {
      return {
        offer: payload,
        sourceUrl: url,
        observedAt: cached!.fetchedAt,
        stale: true,
        note: `A fresh read of this page is already running; showing the price read ${describeAge(cached!.fetchedAt)}.`,
        error: null,
        variantMatches,
      };
    }
    return {
      offer: null,
      sourceUrl: url,
      observedAt: now,
      stale: false,
      note: null,
      error: "A read of this page is already running.",
      variantMatches: true,
    };
  }

  const token = claim.token;
  let extraction: Awaited<ReturnType<typeof ctx.runAction<typeof internal.firecrawl.extractOffer>>>;
  try {
    extraction = await ctx.runAction(internal.firecrawl.extractOffer, {
      url,
      expectedKey: canonicalKey,
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await ctx.runMutation(internal.cache.fail, { kind: "offer", key: canonicalKey, error, token });
    if (payload) {
      return {
        offer: payload,
        sourceUrl: url,
        observedAt: cached!.fetchedAt,
        stale: true,
        note: `This page could not be read right now, so this is the price read ${describeAge(cached!.fetchedAt)}.`,
        error,
        variantMatches,
      };
    }
    return { offer: null, sourceUrl: url, observedAt: now, stale: false, note: null, error, variantMatches: true };
  }
  // A page can answer with no price (a bot wall). That must never overwrite a priced
  // cache entry, or the honest fallback disappears for a whole TTL.
  const hasPrice = extraction.ok && extraction.offer !== null && (extraction.offer.priceCents ?? 0) > 0;
  if (hasPrice && extraction.offer) {
    await ctx.runMutation(internal.cache.finish, {
      kind: "offer",
      key: canonicalKey,
      payload: JSON.stringify({ offer: extraction.offer, variantMatches: extraction.variantMatches }),
      source: "firecrawl",
      simulated: false,
      token,
    });
    return {
      offer: extraction.offer,
      sourceUrl: extraction.sourceUrl ?? url,
      observedAt: now,
      stale: false,
      note: null,
      error: null,
      variantMatches: extraction.variantMatches,
    };
  }

  const error = extraction.error ?? "the page returned no price";
  await ctx.runMutation(internal.cache.fail, { kind: "offer", key: canonicalKey, error, token });
  if (payload) {
    return {
      offer: payload,
      sourceUrl: url,
      observedAt: cached!.fetchedAt,
      stale: true,
      note: `This page could not be read right now, so this is the price read ${describeAge(
        cached!.fetchedAt,
      )}.`,
      error,
      variantMatches,
    };
  }
  return { offer: null, sourceUrl: url, observedAt: now, stale: false, note: null, error, variantMatches: true };
}

export const enrichOfferFromWeb = internalAction({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    if (!env.FIRECRAWL_API_KEY) return null;
    const data = await ctx.runQuery(internal.enrichment.getSectionContext, { cartItemId });
    if (!data) return null;
    const extraction = await extractWithCache(ctx, data.offer.url, data.offer.canonicalKey, false);
    const usable =
      extraction.offer !== null && (extraction.offer.priceCents !== null || extraction.offer.seller !== null);
    if (!usable) {
      await ctx.runMutation(internal.enrichment.recordExtractionFailure, {
        offerId: data.offer._id,
        error: extraction.error ?? "the page returned no price or seller",
      });
    } else if (extraction.offer) {
      await ctx.runMutation(internal.enrichment.applyExtractedOffer, {
        offerId: data.offer._id,
        extraction: extraction.offer,
        sourceUrl: extraction.sourceUrl ?? data.offer.url,
        variantMatches: extraction.variantMatches,
        observedAt: extraction.observedAt,
        note: extraction.note ?? undefined,
      });
    }
    // The policy page is a separate scrape and stands on its own, even when the
    // listing itself could not be extracted.
    // Cross-store comparison starts once the saved product is resolved.
    await ctx.scheduler.runAfter(0, internal.exa.startLookup, { cartItemId });
    // Retailers without a known policy page: read the terms off the listing itself.
    const policyUrl = RETURN_POLICY_URLS[data.offer.retailer] ?? data.offer.url;
    const terms = await ctx.runAction(internal.firecrawl.extractReturnTerms, { url: policyUrl });
    if (!terms.ok || !terms.terms) return null;
    // Keep whatever we already had when the policy page yielded nothing usable.
    const stated =
      terms.terms.windowDays !== null ||
      terms.terms.freeReturns !== null ||
      terms.terms.openedItemRestrictions !== null;
    if (!stated) return null;
    await ctx.runMutation(internal.enrichment.applyExtractedReturnTerms, {
      cartItemId,
      offerId: data.offer._id,
      terms: terms.terms,
      sourceUrl: terms.sourceUrl ?? policyUrl,
    });
    return null;
  },
});

const extractedOffer = v.object({
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
  imageUrl: v.union(v.string(), v.null()),
  evidence: v.union(v.string(), v.null()),
});

export const applyExtractedOffer = internalMutation({
  args: {
    offerId: v.id("offers"),
    extraction: extractedOffer,
    sourceUrl: v.string(),
    variantMatches: v.boolean(),
    observedAt: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { offerId, extraction, sourceUrl, variantMatches, observedAt, note }) => {
    const offer = await ctx.db.get("offers", offerId);
    if (!offer) return null;
    const provenance = {
      method: "firecrawl" as const,
      sourceUrl,
      observedAt,
      supportingText: extraction.evidence,
      verifiedKey: extraction.asinOrSku,
      note:
        note ??
        (variantMatches ? null : "The scraped page named a different variant, so its price was not applied."),
    };
    if (!variantMatches) {
      await ctx.db.patch("offers", offerId, { provenance });
      return null;
    }
    const conditionClass = classifyCondition(extraction.condition);
    if (isWithheldCondition({ condition: extraction.condition ?? undefined, conditionClass })) {
      // Only a new-condition offer may stand in for the item. Record what the page
      // really sells as a labeled alternate and leave the offer untouched.
      const alternates = [
        ...(offer.alternates ?? []).filter(
          (a) =>
            a.seller !== extraction.seller ||
            a.priceCents !== extraction.priceCents ||
            a.condition !== extraction.condition,
        ),
        {
          conditionClass,
          condition: extraction.condition ?? null,
          seller: extraction.seller,
          priceCents: extraction.priceCents,
          sourceUrl,
          observedAt,
        },
      ].slice(-10);
      await ctx.db.patch("offers", offerId, {
        alternates,
        provenance: {
          ...provenance,
          note: `The live page lists a ${extraction.condition ?? "non-new"} offer from ${
            extraction.seller ?? "an unknown seller"
          } at ${extraction.priceCents !== null ? "$" + (extraction.priceCents / 100).toFixed(2) : "an unknown price"}; it is not applied because the offer is not new.`,
        },
      });
      return null;
    }
    const product = await ctx.db.get("products", offer.productId);
    const extractedImage = resolveImageUrl(extraction.imageUrl, sourceUrl);
    if (product && !product.imageUrl && extractedImage) {
      await ctx.db.patch("products", product._id, { imageUrl: extractedImage });
    }
    const hasPrice = extraction.priceCents !== null && extraction.priceCents > 0;
    await ctx.db.patch("offers", offerId, {
      provenance,
      // A page that yields no price (a bot wall) must never look live.
      simulated: hasPrice ? false : offer.simulated,
      updatedAt: observedAt,
      conditionClass,
      priceCents: hasPrice ? extraction.priceCents! : offer.priceCents,
      seller: extraction.seller ?? offer.seller,
      condition: extraction.condition ?? offer.condition,
      inStock: extraction.availability
        ? !/out of stock|unavailable/i.test(extraction.availability)
        : offer.inStock,
      rating:
        extraction.starRating !== null && extraction.ratingCount !== null
          ? { average: extraction.starRating, count: extraction.ratingCount }
          : offer.rating,
    });
    if (hasPrice) {
      await ctx.db.insert("priceObservations", {
        offerId,
        priceCents: extraction.priceCents!,
        shippingCents: offer.shippingCents,
        observedAt,
        source: "Firecrawl",
        simulated: false,
      });
      await ctx.runMutation(internal.enrichment.refreshPriceHistoryForOffer, { offerId });
    }
    return null;
  },
});

export const recordExtractionFailure = internalMutation({
  args: { offerId: v.id("offers"), error: v.string() },
  handler: async (ctx, { offerId, error }) => {
    const offer = await ctx.db.get("offers", offerId);
    if (!offer || offer.provenance?.method === "firecrawl") return null;
    await ctx.db.patch("offers", offerId, {
      provenance: {
        method: offer.simulated ? ("seed" as const) : ("seed" as const),
        sourceUrl: offer.url,
        observedAt: Date.now(),
        supportingText: null,
        verifiedKey: null,
        note: `Firecrawl extraction failed, so this offer keeps its seeded demo values: ${error.slice(0, 200)}`,
      },
    });
    return null;
  },
});

export const applyExtractedReturnTerms = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    offerId: v.id("offers"),
    terms: v.object({
      windowDays: v.union(v.number(), v.null()),
      freeReturns: v.union(v.boolean(), v.null()),
      openedItemRestrictions: v.union(v.string(), v.null()),
      appliesTo: v.union(v.literal("offer"), v.literal("storewide"), v.null()),
      evidence: v.union(v.string(), v.null()),
    }),
    sourceUrl: v.string(),
  },
  handler: async (ctx, { cartItemId, offerId, terms, sourceUrl }) => {
    const ev = await findSection(ctx, cartItemId, "returnTerms");
    if (!ev) return null;
    const offer = await ctx.db.get("offers", offerId);
    const thirdParty = !!offer && offer.seller !== offer.retailerName && offer.retailer === "amazon";
    // A storewide policy only settles this offer when the seller is the retailer
    // itself; a marketplace seller can differ.
    const status: "confirmed" | "unconfirmed" =
      terms.appliesTo === null || thirdParty ? "unconfirmed" : "confirmed";
    const eligibilityScope = status === "confirmed" ? terms.appliesTo ?? "storewide" : "unconfirmed";
    const highlights = [
      terms.windowDays !== null
        ? { label: "Return window", detail: `${terms.windowDays} days`, tone: "neutral" as const }
        : { label: "Return window", detail: "Not stated on the policy page", tone: "neutral" as const },
      terms.freeReturns !== null
        ? {
            label: "Return shipping",
            detail: terms.freeReturns ? "Free" : "Paid by the shopper",
            tone: terms.freeReturns ? ("positive" as const) : ("negative" as const),
          }
        : { label: "Return shipping", detail: "Not stated", tone: "neutral" as const },
      terms.openedItemRestrictions !== null
        ? { label: "Opened items", detail: terms.openedItemRestrictions, tone: "neutral" as const }
        : { label: "Opened items", detail: "No restriction stated", tone: "neutral" as const },
      {
        label: "Eligibility",
        detail:
          status === "confirmed"
            ? "Confirmed for this offer's seller"
            : "Unconfirmed: the policy is storewide and this offer's seller is a marketplace seller",
        tone: status === "confirmed" ? ("positive" as const) : ("neutral" as const),
      },
    ];
    await ctx.db.patch("evidence", ev._id, {
      status: "ready",
      checkedAt: Date.now(),
      simulated: false,
      summary:
        terms.windowDays !== null
          ? `${terms.windowDays}-day return window${terms.freeReturns ? " with free return shipping" : ""}.${status === "unconfirmed" ? " Applies storewide; confirm for this seller at checkout." : ""}`
          : "Return policy page did not state a window.",
      highlights,
      sources: [
        {
          title: `${offer?.retailerName ?? "Retailer"} return policy`,
          url: sourceUrl,
          publisher: offer?.retailerName,
        },
      ],
      details: {
        returnWindowDays: terms.windowDays,
        freeReturns: terms.freeReturns,
        openedItemRestrictions: terms.openedItemRestrictions,
        eligibilityScope,
        status,
        supportingText: terms.evidence,
        sourceUrl,
      },
      error: undefined,
    });
    return null;
  },
});


/** Amazon items get their history from Keepa; the listing scrape runs in parallel. */
function keepaUrlFor(item: { url: string; offerId?: unknown }, canonicalKey: string | null): string | null {
  if (!canonicalKey || !canonicalKey.startsWith("amazon:")) return null;
  const asin = canonicalKey.slice("amazon:".length);
  try {
    return keepaProductUrl(new URL(item.url).hostname, asin);
  } catch {
    return null;
  }
}

export const enrichHistoryFromKeepa = internalAction({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const data = await ctx.runQuery(internal.enrichment.getSectionContext, { cartItemId });
    if (!data) return null;
    const keepaUrl = keepaUrlFor(data.item, data.offer.canonicalKey);
    if (!keepaUrl) {
      await ctx.runMutation(internal.enrichment.publishHistory, {
        cartItemId,
        mode: "observations",
        summary: null,
        note: "Not an Amazon listing, so history comes from observations we recorded.",
        seriesLabel: null,
        currency: "USD",
        sourceUrl: data.offer.url,
        points: [],
      });
      return null;
    }
    const result = await ctx.runAction(internal.keepa.extractPriceHistory, { url: keepaUrl });
    if (result.ok && result.points.length > 0) {
      await ctx.runMutation(internal.enrichment.publishHistory, {
        cartItemId,
        mode: result.mode === "sampled" ? "sampled" : "live",
        summary:
          result.mode === "sampled"
            ? `Sampled from Keepa: ${result.points.length} price points read off the chart.`
            : `Keepa history for ${result.seriesLabel ?? "Amazon"}: ${result.points.length} price points.`,
        note: result.note,
        seriesLabel: result.seriesLabel,
        currency: result.currency ?? "USD",
        sourceUrl: keepaUrl,
        points: result.points,
      });
      return null;
    }
    await ctx.runMutation(internal.enrichment.publishHistory, {
      cartItemId,
      mode: "fallback",
      summary: "View price history on Keepa",
      note: result.note ?? "Keepa returned no readable points.",
      seriesLabel: result.seriesLabel,
      currency: result.currency,
      sourceUrl: keepaUrl,
      points: [],
    });
    return null;
  },
});

export const publishHistory = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    mode: v.union(
      v.literal("live"),
      v.literal("sampled"),
      v.literal("fallback"),
      v.literal("observations"),
    ),
    summary: v.union(v.string(), v.null()),
    note: v.union(v.string(), v.null()),
    seriesLabel: v.union(v.string(), v.null()),
    currency: v.union(v.string(), v.null()),
    sourceUrl: v.string(),
    points: v.array(v.object({ at: v.union(v.number(), v.null()), priceCents: v.number() })),
  },
  handler: async (ctx, { cartItemId, mode, summary, note, seriesLabel, currency, sourceUrl, points }) => {
    const ev = await findSection(ctx, cartItemId, "priceHistory");
    if (!ev) return null;
    if (mode === "observations") {
      // Let the observation-based section compute itself as before.
      await ctx.scheduler.runAfter(0, internal.enrichment.runSection, { cartItemId, section: "priceHistory" });
      return null;
    }
    await ctx.db.patch("evidence", ev._id, {
      status: "ready",
      checkedAt: Date.now(),
      simulated: false,
      summary: summary ?? undefined,
      highlights:
        mode === "fallback"
          ? [
              {
                label: "Price history",
                detail: note ?? "Keepa returned no readable points.",
                tone: "neutral" as const,
              },
            ]
          : [
              {
                label: mode === "sampled" ? "Sampled from Keepa" : (seriesLabel ?? "Keepa"),
                detail: `${points.length} dated points`,
                tone: "neutral" as const,
              },
            ],
      sources: [{ title: "Keepa price history", url: sourceUrl, publisher: "Keepa" }],
      history: { mode, seriesLabel, currency, sourceUrl, sampled: mode === "sampled", note, points },
      error: undefined,
    });
    await recomputeStatus(ctx, cartItemId);
    return null;
  },
});

export const start = internalMutation({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item || !item.offerId) return null;
    for (const section of SECTION_NAMES) {
      const existing = await ctx.db
        .query("evidence")
        .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId).eq("section", section))
        .unique();
      if (existing) continue;
      const isAmazon = !!item.url && /amazon\./i.test(item.url);
      await ctx.db.insert("evidence", {
        shopperId: item.shopperId,
        cartItemId,
        section,
        status: section === "priceHistory" && isAmazon ? "loading" : "pending",
        attempts: 0,
        scope: SECTION_SCOPE[section],
        highlights: [],
        sources: [],
        simulated: false,
      });
      if (section === "priceHistory" && isAmazon) {
        await ctx.scheduler.runAfter(SECTION_DELAY_MS[section], internal.enrichment.enrichHistoryFromKeepa, {
          cartItemId,
        });
        continue;
      }
      await ctx.scheduler.runAfter(SECTION_DELAY_MS[section], internal.enrichment.runSection, {
        cartItemId,
        section,
      });
    }
    await ctx.db.patch("cartItems", cartItemId, { enrichmentStatus: "enriching" });
    if (env.FIRECRAWL_API_KEY) {
      await ctx.scheduler.runAfter(200, internal.enrichment.enrichOfferFromWeb, { cartItemId });
    }
    return null;
  },
});

/**
 * Re-runs the sections an item still needs, mirroring start()'s scheduling: the
 * reset rows are the ones start() skips, so they need their workers enqueued here.
 */
export const restartSections = internalMutation({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item || !item.offerId) return null;
    const isAmazon = !!item.url && /amazon\./i.test(item.url);
    const rows = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId))
      .take(20);
    for (const section of SECTION_NAMES) {
      const row = rows.find((r) => r.section === section);
      if (row && row.status === "ready") continue;
      if (row) {
        await ctx.db.patch("evidence", row._id, {
          status: section === "priceHistory" && isAmazon ? "loading" : "pending",
          attempts: 0,
          error: undefined,
          pendingRun: undefined,
        });
      } else {
        await ctx.db.insert("evidence", {
          shopperId: item.shopperId,
          cartItemId,
          section,
          status: section === "priceHistory" && isAmazon ? "loading" : "pending",
          attempts: 0,
          scope: SECTION_SCOPE[section],
          highlights: [],
          sources: [],
          simulated: false,
        });
      }
      if (section === "priceHistory" && isAmazon) {
        await ctx.scheduler.runAfter(
          SECTION_DELAY_MS[section],
          internal.enrichment.enrichHistoryFromKeepa,
          { cartItemId },
        );
        continue;
      }
      await ctx.scheduler.runAfter(SECTION_DELAY_MS[section], internal.enrichment.runSection, {
        cartItemId,
        section,
      });
    }
    await ctx.db.patch("cartItems", cartItemId, { enrichmentStatus: "enriching" });
    if (env.FIRECRAWL_API_KEY) {
      // Same listing refresh start() performs, so a retried item re-reads its page.
      await ctx.scheduler.runAfter(200, internal.enrichment.enrichOfferFromWeb, { cartItemId });
    }
    return null;
  },
});

export const resolveOffer = internalAction({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.runQuery(internal.enrichment.getItemInternal, { cartItemId });
    if (!item || item.offerId) return null;
    if (env.FIRECRAWL_API_KEY) {
      const extraction = await extractWithCache(
        ctx,
        item.url,
        canonicalKeyForUrl(item.url) ?? item.url,
        false,
      );
      if (
        extraction.offer &&
        extraction.variantMatches &&
        extraction.offer.priceCents !== null &&
        extraction.offer.priceCents > 0
      ) {
        await ctx.runMutation(internal.enrichment.attachExtractedOffer, {
          cartItemId,
          extraction: extraction.offer,
          sourceUrl: extraction.sourceUrl ?? item.url,
          observedAt: extraction.observedAt,
          note: extraction.note ?? undefined,
        });
        return null;
      }
    }
    let og: Awaited<ReturnType<typeof fetchOpenGraph>> = {};
    try {
      og = await fetchOpenGraph(item.url);
    } catch (e) {
      console.warn("OpenGraph fetch failed", item.url, String(e));
    }
    await ctx.runMutation(internal.enrichment.attachOffer, {
      cartItemId,
      title: og.title ?? titleFromUrl(item.url),
      imageUrl: og.image ?? "",
      description: og.description ?? "",
      priceCents: og.priceCents ?? 0,
    });
    return null;
  },
});

/** Creates the offer straight from a verified Firecrawl extraction. */
export const attachExtractedOffer = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    extraction: extractedOffer,
    sourceUrl: v.string(),
    observedAt: v.number(),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { cartItemId, extraction, sourceUrl, observedAt, note }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item || item.offerId) return null;
    const { retailer, retailerName } = retailerFromHost(new URL(item.url).hostname);
    const canonicalKey = canonicalKeyForUrl(item.url)!;
    const existing = await ctx.db
      .query("offers")
      .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", canonicalKey))
      .first();
    if (existing) {
      await ctx.db.patch("cartItems", item._id, {
        productId: existing.productId,
        variantId: existing.variantId,
        offerId: existing._id,
      });
      await ctx.runMutation(internal.enrichment.start, { cartItemId: item._id });
      return null;
    }
    const productId = await ctx.db.insert("products", {
      title: (extraction.model ?? titleFromUrl(item.url)).slice(0, 200),
      category: "general",
      imageUrl: resolveImageUrl(extraction.imageUrl, sourceUrl) ?? undefined,
    });
    const variantId = await ctx.db.insert("variants", { productId, label: extraction.variant ?? "Default" });
    const outOfStock = extraction.availability ? /out of stock|unavailable/i.test(extraction.availability) : false;
    const offerId = await ctx.db.insert("offers", {
      productId,
      variantId,
      retailer: extraction.retailer && extraction.retailer.length > 0 ? retailer : retailer,
      retailerName: extraction.retailer ?? retailerName,
      seller: extraction.seller ?? retailerName,
      url: item.url,
      canonicalKey,
      priceCents: extraction.priceCents ?? 0,
      shippingCents: 0,
      currency: extraction.currency ?? "USD",
      deliveryEstimate: "Delivery estimate unavailable",
      returnSummary: RETAILER_RETURN_TERMS[retailer]?.summary ?? "See retailer for return terms.",
      condition: extraction.condition ?? undefined,
      conditionClass: classifyCondition(extraction.condition),
      rating:
        extraction.starRating !== null && extraction.ratingCount !== null
          ? { average: extraction.starRating, count: extraction.ratingCount }
          : undefined,
      provenance: {
        method: "firecrawl",
        sourceUrl,
        observedAt,
        supportingText: extraction.evidence,
        verifiedKey: extraction.asinOrSku,
        note: note ?? null,
      },
      inStock: !outOfStock,
      simulated: false,
      updatedAt: observedAt,
    });
    if (extraction.priceCents && extraction.priceCents > 0) {
      await ctx.db.insert("priceObservations", {
        offerId,
        priceCents: extraction.priceCents,
        shippingCents: 0,
        observedAt,
        source: "Firecrawl",
        simulated: false,
      });
    }
    await ctx.db.patch("cartItems", item._id, { productId, variantId, offerId });
    await ctx.runMutation(internal.enrichment.start, { cartItemId: item._id });
    return null;
  },
});

export const attachOffer = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    title: v.string(),
    imageUrl: v.string(),
    description: v.string(),
    priceCents: v.number(),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("cartItems", args.cartItemId);
    if (!item || item.offerId) return null;
    const url = new URL(item.url);
    const { retailer, retailerName } = retailerFromHost(url.hostname);
    const canonicalKey = canonicalKeyForUrl(item.url)!;
    let offer = await ctx.db
      .query("offers")
      .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", canonicalKey))
      .first();
    if (!offer) {
      const productId = await ctx.db.insert("products", {
        title: args.title.slice(0, 200),
        category: "general",
        imageUrl: args.imageUrl || undefined,
        description: args.description ? args.description.slice(0, 500) : undefined,
      });
      const variantId = await ctx.db.insert("variants", { productId, label: "Default" });
      const now = Date.now();
      const offerId = await ctx.db.insert("offers", {
        productId,
        variantId,
        retailer,
        retailerName,
        seller: retailerName,
        url: item.url,
        canonicalKey,
        priceCents: args.priceCents,
        shippingCents: 0,
        currency: "USD",
        deliveryEstimate: "Delivery estimate unavailable",
        returnSummary: RETAILER_RETURN_TERMS[retailer]?.summary ?? "See retailer for return terms.",
        conditionClass: "unknown" as const,
        inStock: args.priceCents > 0,
        simulated: args.priceCents <= 0,
        updatedAt: now,
      });
      if (args.priceCents > 0) {
        await ctx.db.insert("priceObservations", {
          offerId,
          priceCents: args.priceCents,
          shippingCents: 0,
          observedAt: now,
          source: "OpenGraph",
          simulated: false,
        });
      }
      offer = (await ctx.db.get("offers", offerId))!;
    }
    await ctx.db.patch("cartItems", item._id, {
      productId: offer.productId,
      variantId: offer.variantId,
      offerId: offer._id,
    });
    await ctx.runMutation(internal.enrichment.start, { cartItemId: item._id });
    return null;
  },
});

export const sectionHistoryMode = internalQuery({
  args: { cartItemId: v.id("cartItems"), section: sectionName },
  handler: async (ctx, { cartItemId, section }) => {
    const ev = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) =>
        q.eq("cartItemId", cartItemId).eq("section", section),
      )
      .unique();
    return ev?.history?.mode ?? null;
  },
});

export const getItemInternal = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => await ctx.db.get("cartItems", cartItemId),
});

export const getSectionContext = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item?.offerId || !item.productId) return null;
    const product = (await ctx.db.get("products", item.productId))!;
    const offer = (await ctx.db.get("offers", item.offerId))!;
    const observations = await ctx.db
      .query("priceObservations")
      .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
      .order("asc")
      .take(200);
    return { item, product, offer, observations };
  },
});

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function priceHistoryResult(offer: Doc<"offers">, observations: Doc<"priceObservations">[]): SectionResult {
  const prices = observations.map((o) => o.priceCents);
  if (prices.length === 0) {
    return {
      scope: "offer",
      simulated: offer.simulated,
      summary: "No price history yet; tracking starts now.",
      highlights: [],
      sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
    };
  }
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const current = offer.priceCents;
  const pctBelowHigh = high > 0 ? Math.round(((high - current) / high) * 100) : 0;
  return {
    scope: "offer",
    simulated: observations.some((o) => o.simulated),
    summary:
      current <= low
        ? `${dollars(current)} is the lowest price seen in ${observations.length} observations.`
        : `${dollars(current)} now; low ${dollars(low)}, high ${dollars(high)}.`,
    highlights: [
      { label: "Current", detail: dollars(current), tone: current <= low ? "positive" : "neutral" },
      { label: "Lowest seen", detail: dollars(low), tone: "neutral" },
      { label: "Highest seen", detail: dollars(high), tone: "neutral" },
      { label: "Below high", detail: `${pctBelowHigh}%`, tone: pctBelowHigh >= 20 ? "positive" : "neutral" },
    ],
    sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
  };
}

async function redditResult(product: Doc<"products">): Promise<SectionResult> {
  const q = `${product.title.split(" ").slice(0, 4).join(" ")}`;
  const res = await fetch(
    `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&limit=5&sort=relevance&t=year`,
    {
      headers: { "User-Agent": "web:mobilehack-cart:0.1 (hackathon demo)" },
      // A blocked request can hang for minutes; fail fast so the Exa handoff starts.
      signal: AbortSignal.timeout(8_000),
    },
  );
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: {
      children?: {
        data: {
          title: string;
          permalink: string;
          subreddit_name_prefixed: string;
          score: number;
          num_comments: number;
          author?: string | null;
          created_utc?: number;
          selftext?: string;
        };
      }[];
    };
  };
  const posts = (body.data?.children ?? []).map((c) => c.data).slice(0, 3);
  if (posts.length === 0) throw new Error("No Reddit threads found");
  return {
    scope: "product",
    simulated: false,
    summary: `${posts.length} recent Reddit threads mention this product.`,
    highlights: posts.map((p) => ({
      label: p.subreddit_name_prefixed,
      detail: `${p.title} (${p.score} points, ${p.num_comments} comments)`,
      tone: "neutral" as const,
    })),
    sources: posts.map((p) => ({ title: p.title, url: `https://www.reddit.com${p.permalink}`, publisher: "Reddit" })),
    items: posts.map((p) => ({
      author: p.author ?? null,
      text: p.selftext ? `${p.title} — ${p.selftext.slice(0, 240)}` : p.title,
      url: `https://www.reddit.com${p.permalink}`,
      createdAt: p.created_utc ? p.created_utc * 1000 : null,
      score: typeof p.score === "number" ? p.score : null,
      community: p.subreddit_name_prefixed,
    })),
  };
}

async function produce(
  ctx: ActionCtx,
  section: SectionName,
  ctxData: { product: Doc<"products">; offer: Doc<"offers">; observations: Doc<"priceObservations">[] },
  cartItemId: Id<"cartItems">,
): Promise<SectionResult> {
  const { product, offer, observations } = ctxData;
  const seeded = !product.demoKey
    ? undefined
    : SECTION_SCOPE[section] === "offer"
      ? SEEDED_OFFER_EVIDENCE[`${product.demoKey}:${offer.retailer}`]?.[section]
      : SEEDED_EVIDENCE[product.demoKey]?.[section];
  switch (section) {
    case "priceHistory":
      // Without a price read from the page there is no series to show; a simulated
      // one would put invented numbers where the listing should be.
      if (!product.demoKey && (offer.priceCents <= 0 || offer.simulated)) {
        throw new Error("No price could be read from the listing, so there is no price history yet.");
      }
      return priceHistoryResult(offer, observations);
    case "returnTerms":
      // Seeded policy text is a fallback for seeded offers only; a live offer uses
      // its own return summary until the policy scrape lands.
      return (
        seeded ??
        (offer.simulated ? RETAILER_RETURN_TERMS[offer.retailer] : undefined) ?? {
          scope: "offer",
          simulated: false,
          summary: offer.returnSummary,
          highlights: [
            {
              label: "Return summary",
              detail: offer.returnSummary,
              tone: "neutral" as const,
            },
          ],
          sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
        }
      );
    case "reddit": {
      try {
        return await redditResult(product);
      } catch (directError) {
        if (seeded) return seeded;
        // Reddit blocks our cloud IPs: hand the section to an Exa agent run, whose
        // result is published by its own polling step.
        await ctx.runAction(internal.exa.startRedditLookup, {
          cartItemId,
          productTitle: product.title,
        });
        throw directError;
      }
    }
    case "categoryGuidance": {
      if (seeded) return seeded;
      const guidance = await ctx.runAction(internal.firecrawl.extractGuidance, { url: offer.url });
      if (!guidance.ok || guidance.criteria.length === 0) {
        if (offer.simulated) {
          // The offer itself is a placeholder (no price was ever extracted), so its
          // fields are defaults, not listing facts.
          throw new Error(guidance.error ?? "No category guidance could be read from the page");
        }
        // The guidance scrape is best-effort. What we already hold about the offer
        // is still real page data, so describe that instead of failing the section.
        const facts: { label: string; detail: string; tone: "positive" | "negative" | "neutral" | "new_criterion" }[] = [];
        if (offer.condition) facts.push({ label: "Condition", detail: offer.condition, tone: "neutral" });
        facts.push({ label: "Sold by", detail: offer.seller, tone: "neutral" });
        facts.push({
          label: "Availability",
          detail: offer.inStock ? "In stock at the retailer" : "Not currently in stock",
          tone: offer.inStock ? "positive" : "negative",
        });
        if (offer.rating) {
          facts.push({
            label: "Ratings",
            detail: `${offer.rating.average} of 5 from ${offer.rating.count} ratings`,
            tone: "neutral",
          });
        }
        facts.push({
          label: "Check the warranty and returns before buying",
          detail:
            "The page states the seller and condition above; confirm warranty coverage and the return window for this seller, which shoppers usually forget to ask about.",
          tone: "new_criterion",
        });
        return {
          scope: "product",
          simulated: false,
          summary:
            guidance.error !== null
              ? `Guidance read from the listing itself: ${guidance.error.slice(0, 120)}`
              : "Guidance read from the listing itself.",
          highlights: facts,
          sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
        };
      }
      return {
        scope: "product",
        simulated: false,
        summary:
          guidance.criteria.find((c: { overlooked: boolean | null }) => c.overlooked)?.detail ??
          `Buying criteria read from the ${guidance.category ?? product.category} listing.`,
        highlights: guidance.criteria.map((c: { label: string; detail: string | null; whyItMatters: string | null; tone: string | null; overlooked: boolean | null }) => ({
          label: c.label,
          detail: [c.detail, c.whyItMatters].filter(Boolean).join(" ") || "Read from the listing.",
          tone:
            c.overlooked === true
              ? ("new_criterion" as const)
              : c.tone === "positive"
                ? ("positive" as const)
                : c.tone === "negative"
                  ? ("negative" as const)
                  : ("neutral" as const),
        })),
        sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
      };
    }
    case "retailerReviews":
      if (seeded) return seeded;
      return offer.rating
        ? {
            scope: "offer",
            simulated: offer.simulated,
            summary: `${offer.rating.average} of 5 from ${offer.rating.count} ${offer.retailerName} ratings.`,
            highlights: [],
            sources: [{ title: `${offer.retailerName} reviews`, url: offer.url, publisher: offer.retailerName }],
          }
        : {
            scope: "offer",
            simulated: false,
            summary: `No review data available for ${offer.retailerName} yet.`,
            highlights: [],
            sources: [],
          };
  }
}

export const sectionState = internalQuery({
  args: { cartItemId: v.id("cartItems"), section: sectionName },
  handler: async (ctx, { cartItemId, section }) => {
    const ev = await findSection(ctx, cartItemId, section);
    if (!ev) return null;
    return { status: ev.status, pendingRun: ev.pendingRun ?? null };
  },
});

export const runSection = internalAction({
  args: { cartItemId: v.id("cartItems"), section: sectionName },
  handler: async (ctx, { cartItemId, section }) => {
    // Terminal evidence is not rebuilt, and a section handed to an Exa run is that
    // run's to publish: a late retry must not reset it to running.
    const current = await ctx.runQuery(internal.enrichment.sectionState, { cartItemId, section });
    if (current && (current.status === "ready" || current.status === "failed" || current.pendingRun)) {
      return null;
    }
    if (section === "priceHistory") {
      // A resolved Keepa series is the record; local observations must not replace it.
      const existing = await ctx.runQuery(internal.enrichment.sectionHistoryMode, {
        cartItemId,
        section,
      });
      if (existing === "live" || existing === "sampled") return null;
    }
    const attempt = await ctx.runMutation(internal.enrichment.markRunning, { cartItemId, section });
    if (attempt === null) return null;
    const data = await ctx.runQuery(internal.enrichment.getSectionContext, { cartItemId });
    if (!data) return null;
    try {
      const { scope: _scope, ...result } = await produce(ctx, section, data, cartItemId);
      if (section === "returnTerms") {
        await ctx.runMutation(internal.enrichment.markReturnTermsUnconfirmed, {
          cartItemId,
          sourceUrl: data.offer.url,
          summary: result.summary,
        });
      }
      await ctx.runMutation(internal.enrichment.publishSection, {
        cartItemId,
        section,
        ...result,
        highlights:
          section === "categoryGuidance"
            ? [...result.highlights].sort(
                (a: { tone: string }, b: { tone: string }) =>
                  Number(b.tone === "new_criterion") - Number(a.tone === "new_criterion"),
              )
            : result.highlights,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const state = await ctx.runQuery(internal.enrichment.sectionState, { cartItemId, section });
      if (state?.pendingRun) return null;
      const retry = attempt < MAX_ATTEMPTS;
      await ctx.runMutation(internal.enrichment.markFailedAttempt, { cartItemId, section, error, final: !retry });
      if (retry) {
        await ctx.scheduler.runAfter(2_000 * 2 ** attempt, internal.enrichment.runSection, { cartItemId, section });
      }
    }
    return null;
  },
});

async function findSection(ctx: QueryCtx | MutationCtx, cartItemId: Id<"cartItems">, section: SectionName) {
  return await ctx.db
    .query("evidence")
    .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId).eq("section", section))
    .unique();
}

export const markRunning = internalMutation({
  args: { cartItemId: v.id("cartItems"), section: sectionName },
  handler: async (ctx, { cartItemId, section }) => {
    const ev = await findSection(ctx, cartItemId, section);
    if (!ev) return null;
    const attempts = ev.attempts + 1;
    await ctx.db.patch("evidence", ev._id, { status: ev.status === "ready" ? "ready" : "running", attempts });
    return attempts;
  },
});

/** Policies we could not read stay structured but unconfirmed, never implied as covered. */
export const markReturnTermsUnconfirmed = internalMutation({
  args: { cartItemId: v.id("cartItems"), sourceUrl: v.string(), summary: v.string() },
  handler: async (ctx, { cartItemId, sourceUrl, summary }) => {
    const ev = await findSection(ctx, cartItemId, "returnTerms");
    if (!ev || ev.details) return null;
    await ctx.db.patch("evidence", ev._id, {
      details: {
        returnWindowDays: null,
        freeReturns: null,
        openedItemRestrictions: null,
        eligibilityScope: "unconfirmed",
        status: "unconfirmed",
        supportingText: summary,
        sourceUrl,
      },
    });
    return null;
  },
});

export const publishSection = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    section: sectionName,
    summary: v.string(),
    highlights: v.array(highlight),
    sources: v.array(source),
    simulated: v.boolean(),
    items: v.optional(
      v.array(
        v.object({
          author: v.union(v.string(), v.null()),
          text: v.string(),
          url: v.string(),
          createdAt: v.union(v.number(), v.null()),
          score: v.union(v.number(), v.null()),
          community: v.union(v.string(), v.null()),
        }),
      ),
    ),
  },
  handler: async (ctx, { cartItemId, section, ...result }) => {
    const ev = await findSection(ctx, cartItemId, section);
    if (!ev) return null;
    await ctx.db.patch("evidence", ev._id, {
      ...result,
      scope: SECTION_SCOPE[section],
      status: "ready",
      checkedAt: Date.now(),
      error: undefined,
    });
    await recomputeStatus(ctx, cartItemId);
    return null;
  },
});

export const failRedditRun = internalMutation({
  args: { cartItemId: v.id("cartItems"), reason: v.string() },
  handler: async (ctx, { cartItemId, reason }) => {
    const ev = await findSection(ctx, cartItemId, "reddit");
    if (!ev) return null;
    await ctx.db.patch("evidence", ev._id, {
      status: "failed",
      error: reason,
      pendingRun: undefined,
      checkedAt: Date.now(),
    });
    await recomputeStatus(ctx, cartItemId);
    return null;
  },
});

export const markFailedAttempt = internalMutation({
  args: { cartItemId: v.id("cartItems"), section: sectionName, error: v.string(), final: v.boolean() },
  handler: async (ctx, { cartItemId, section, error, final }) => {
    const ev = await findSection(ctx, cartItemId, section);
    if (!ev) return null;
    // A published or already-failed section is terminal; a late attempt must not
    // walk it back to pending.
    if (ev.status === "ready" || ev.status === "failed") return null;
    await ctx.db.patch("evidence", ev._id, {
      // A queued Exa run keeps the section pending rather than failed.
      status: final && !ev.pendingRun ? "failed" : "pending",
      error,
      checkedAt: Date.now(),
    });
    await recomputeStatus(ctx, cartItemId);
    return null;
  },
});

async function recomputeStatus(ctx: MutationCtx, cartItemId: Id<"cartItems">) {
  const all = await ctx.db
    .query("evidence")
    .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId))
    .take(10);
  const done = all.filter((e) => e.status === "ready" || e.status === "failed");
  if (done.length < SECTION_NAMES.length) return;
  const enrichmentStatus = all.every((e) => e.status === "ready") ? "ready" : "partial";
  await ctx.db.patch("cartItems", cartItemId, { enrichmentStatus });
}

/** Re-run priceHistory for every active cart item on an offer (after a new price observation). */
export const refreshPriceHistoryForOffer = internalMutation({
  args: { offerId: v.id("offers") },
  handler: async (ctx, { offerId }) => {
    const items = await ctx.db
      .query("cartItems")
      .withIndex("by_offerId_and_status", (q) => q.eq("offerId", offerId).eq("status", "active"))
      .take(500);
    for (const item of items) {
      await ctx.scheduler.runAfter(0, internal.enrichment.runSection, {
        cartItemId: item._id,
        section: "priceHistory",
      });
    }
    return items.length;
  },
});

export const refreshPriceHistory = internalMutation({
  args: { offerId: v.id("offers") },
  handler: async (ctx, { offerId }) => {
    const items = await ctx.db
      .query("cartItems")
      .withIndex("by_offerId_and_status", (q) => q.eq("offerId", offerId).eq("status", "active"))
      .take(500);
    for (const item of items) {
      await ctx.scheduler.runAfter(0, internal.enrichment.runSection, {
        cartItemId: item._id,
        section: "priceHistory",
      });
    }
    return items.length;
  },
});

export const offerForRevalidation = internalQuery({
  args: { offerId: v.id("offers") },
  handler: async (ctx, { offerId }) => await ctx.db.get("offers", offerId),
});

/**
 * Re-reads the retailer page immediately before money moves and reports whether the
 * quoted total still stands. A page we cannot read is reported as unavailable, never
 * as unchanged.
 */
export const revalidateOffer = internalAction({
  args: { offerId: v.id("offers") },
  handler: async (
    ctx,
    { offerId },
  ): Promise<{
    status: "unchanged" | "changed" | "unavailable";
    totalCents: number | null;
    note: string | null;
  }> => {
    const offer = await ctx.runQuery(internal.enrichment.offerForRevalidation, { offerId });
    if (!offer) return { status: "unavailable", totalCents: null, note: "The offer no longer exists." };
    const extraction = await extractWithCache(ctx, offer.url, offer.canonicalKey, true);
    if (extraction.stale) {
      return {
        status: "unavailable",
        totalCents: null,
        note: `A fresh read of the retailer failed, and a cached price from ${describeAge(
          extraction.observedAt,
        )} cannot authorize a charge. Nothing was charged.`,
      };
    }
    if (!extraction.offer || extraction.offer.priceCents === null) {
      return {
        status: "unavailable",
        totalCents: null,
        note: extraction.error
          ? `The retailer page could not be re-read (${extraction.error}), so nothing was charged.`
          : "The retailer page could not be re-read, so nothing was charged.",
      };
    }
    const liveTotal = extraction.offer.priceCents + offer.shippingCents;
    if (extraction.offer.availability && /out of stock|unavailable/i.test(extraction.offer.availability)) {
      return {
        status: "changed",
        totalCents: liveTotal,
        note: "The retailer now shows this item as unavailable, so the order needs a fresh approval.",
      };
    }
    const quotedTotal = offer.priceCents + offer.shippingCents;
    if (liveTotal !== quotedTotal) {
      return {
        status: "changed",
        totalCents: liveTotal,
        note: `The retailer price moved from ${(quotedTotal / 100).toFixed(2)} to ${(
          liveTotal / 100
        ).toFixed(2)} (read ${describeAge(extraction.observedAt)}), so the order needs a fresh approval.`,
      };
    }
    return { status: "unchanged", totalCents: liveTotal, note: null };
  },
});
