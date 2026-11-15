import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { SECTION_NAMES, sectionName, highlight, source, type SectionName } from "./lib/validators";
import {
  RETAILER_RETURN_TERMS,
  SEEDED_EVIDENCE,
  SEEDED_OFFER_EVIDENCE,
  type SectionResult,
} from "./lib/demoData";
import { fetchOpenGraph, titleFromUrl } from "./lib/opengraph";
import { canonicalKeyForUrl, retailerFromHost } from "./lib/urls";

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
      await ctx.db.insert("evidence", {
        shopperId: item.shopperId,
        cartItemId,
        section,
        status: "pending",
        attempts: 0,
        scope: SECTION_SCOPE[section],
        highlights: [],
        sources: [],
        simulated: false,
      });
      await ctx.scheduler.runAfter(SECTION_DELAY_MS[section], internal.enrichment.runSection, {
        cartItemId,
        section,
      });
    }
    await ctx.db.patch("cartItems", cartItemId, { enrichmentStatus: "enriching" });
    return null;
  },
});

export const resolveOffer = internalAction({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.runQuery(internal.enrichment.getItemInternal, { cartItemId });
    if (!item || item.offerId) return null;
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
    { headers: { "User-Agent": "web:mobilehack-cart:0.1 (hackathon demo)" } },
  );
  if (!res.ok) throw new Error(`Reddit HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: { children?: { data: { title: string; permalink: string; subreddit_name_prefixed: string; score: number; num_comments: number } }[] };
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
  };
}

async function produce(
  section: SectionName,
  ctxData: { product: Doc<"products">; offer: Doc<"offers">; observations: Doc<"priceObservations">[] },
): Promise<SectionResult> {
  const { product, offer, observations } = ctxData;
  const seeded = !product.demoKey
    ? undefined
    : SECTION_SCOPE[section] === "offer"
      ? SEEDED_OFFER_EVIDENCE[`${product.demoKey}:${offer.retailer}`]?.[section]
      : SEEDED_EVIDENCE[product.demoKey]?.[section];
  switch (section) {
    case "priceHistory":
      return priceHistoryResult(offer, observations);
    case "returnTerms":
      return (
        seeded ??
        RETAILER_RETURN_TERMS[offer.retailer] ?? {
          scope: "offer",
          simulated: false,
          summary: offer.returnSummary,
          highlights: [],
          sources: [{ title: `${offer.retailerName} listing`, url: offer.url, publisher: offer.retailerName }],
        }
      );
    case "reddit":
      try {
        return await redditResult(product);
      } catch (e) {
        if (seeded) return seeded;
        throw e;
      }
    case "categoryGuidance":
      return (
        seeded ?? {
          scope: "product",
          simulated: true,
          summary: `General buying guidance for ${product.category}.`,
          highlights: [
            { label: "Compare total cost", detail: "Check tax, shipping, and price history before buying.", tone: "neutral" },
            { label: "Return window", detail: "Prefer offers with free returns for items you haven't tried.", tone: "neutral" },
          ],
          sources: [],
        }
      );
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

export const runSection = internalAction({
  args: { cartItemId: v.id("cartItems"), section: sectionName },
  handler: async (ctx, { cartItemId, section }) => {
    const attempt = await ctx.runMutation(internal.enrichment.markRunning, { cartItemId, section });
    if (attempt === null) return null;
    const data = await ctx.runQuery(internal.enrichment.getSectionContext, { cartItemId });
    if (!data) return null;
    try {
      const { scope: _scope, ...result } = await produce(section, data);
      await ctx.runMutation(internal.enrichment.publishSection, {
        cartItemId,
        section,
        ...result,
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const retry = attempt < MAX_ATTEMPTS;
      await ctx.runMutation(internal.enrichment.markFailedAttempt, { cartItemId, section, error, final: !retry });
      if (retry) {
        await ctx.scheduler.runAfter(2_000 * 2 ** attempt, internal.enrichment.runSection, { cartItemId, section });
      }
    }
    return null;
  },
});

async function findSection(ctx: MutationCtx, cartItemId: Id<"cartItems">, section: SectionName) {
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

export const publishSection = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    section: sectionName,
    summary: v.string(),
    highlights: v.array(highlight),
    sources: v.array(source),
    simulated: v.boolean(),
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

export const markFailedAttempt = internalMutation({
  args: { cartItemId: v.id("cartItems"), section: sectionName, error: v.string(), final: v.boolean() },
  handler: async (ctx, { cartItemId, section, error, final }) => {
    const ev = await findSection(ctx, cartItemId, section);
    if (!ev) return null;
    await ctx.db.patch("evidence", ev._id, {
      status: final ? "failed" : "pending",
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
