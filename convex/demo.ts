import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { requireShopper } from "./lib/auth";
import { canonicalKeyForUrl } from "./lib/urls";
import { normalizedQuery } from "./lib/cache";
import {
  AIRFLY_URL,
  HERO_ASIN,
  HERO_DROPPED_PRICE_CENTS,
  HERO_INITIAL_PRICE_CENTS,
  HERO_URL,
  SEED_PRODUCTS,
  historyTimestamp,
} from "./lib/demoData";
import { addItemFor } from "./model/cart";
import { SIMULATED_TAX_RATE, estimateTotals } from "./retail/pricing";

const DEMO_DROP_SOURCE = "Demo control: later price observation";

async function ensureCatalog(ctx: MutationCtx) {
  const now = Date.now();
  for (const p of SEED_PRODUCTS) {
    const existing = await ctx.db
      .query("products")
      .withIndex("by_demoKey", (q) => q.eq("demoKey", p.demoKey))
      .unique();
    if (existing) continue;
    const productId = await ctx.db.insert("products", {
      title: p.title,
      brand: p.brand,
      category: p.category,
      imageUrl: p.imageUrl,
      description: p.description,
      demoKey: p.demoKey,
    });
    const variantIds = new Map<string, Id<"variants">>();
    for (const variant of p.variants) {
      variantIds.set(variant.label, await ctx.db.insert("variants", { productId, ...variant }));
    }
    for (const { history, variantLabel, ...o } of p.offers) {
      const offerId = await ctx.db.insert("offers", {
        ...o,
        productId,
        variantId: variantIds.get(variantLabel)!,
        currency: "USD",
        inStock: true,
        simulated: true,
        updatedAt: now,
      });
      for (const h of history) {
        await ctx.db.insert("priceObservations", {
          offerId,
          priceCents: h.priceCents,
          shippingCents: o.shippingCents,
          observedAt: historyTimestamp(h.daysAgo, now),
          source: "Seeded demo history",
          simulated: true,
        });
      }
    }
  }
}

/**
 * The offer the demo control moves: the item it names, or else the most
 * expensive active item in the caller's cart. Nothing is hardcoded to a product.
 */
async function demoOffer(ctx: MutationCtx, shopperId: Id<"users">, itemId?: Id<"cartItems">) {
  const items = await ctx.db
    .query("cartItems")
    .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", "active"))
    .take(50);
  const chosen = itemId ? items.find((i) => i._id === itemId) : items[0];
  const candidates = itemId ? (chosen ? [chosen] : []) : items;
  let best: { offer: Doc<"offers"> } | null = null;
  for (const item of candidates) {
    if (!item.offerId) continue;
    const offer = await ctx.db.get("offers", item.offerId);
    if (!offer) continue;
    if (!best || offer.priceCents > best.offer.priceCents) best = { offer };
  }
  if (!best) throw new ConvexError({ code: "NO_OFFER", message: "No priced item in the cart to move." });
  return best.offer;
}

export const seedCatalog = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureCatalog(ctx);
    return { heroUrl: HERO_URL, airflyUrl: AIRFLY_URL };
  },
});

/** Seeds the catalog and puts the second-retailer item (Best Buy AirFly Pro) in the caller's cart. */
/** The demo's two stores. Neither is seeded: both arrive through the live pipeline. */
export const DEMO_HERO_URL = "https://www.amazon.com/dp/B0863FR3S9";
export const DEMO_SECOND_URL =
  "https://www.bestbuy.com/site/sony-wh-1000xm5-wireless-noise-canceling-over-the-ear-headphones-black/6505727.p";

export const setupMyCart = mutation({
  returns: v.object({ heroUrl: v.string(), secondItemId: v.id("cartItems") }),
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    await ensureCatalog(ctx);
    const second = await addItemFor(
      ctx,
      shopperId,
      {
        url: DEMO_SECOND_URL,
        reason: "A second store for the same shortlist",
        idempotencyKey: "demo-second-store",
      },
      "app",
    );
    return { heroUrl: DEMO_HERO_URL, secondItemId: second.itemId };
  },
});

/** $250 all-in target the demo price drop aims under. */
const DEMO_ALL_IN_TARGET_CENTS = 25000;

/** Largest item price whose all-in total still lands at or under the target. */
function dropPriceFor(currentCents: number, shippingCents: number): number {
  const allIn = (price: number) => estimateTotals(price, shippingCents, 1).totalCents;
  let price = Math.min(currentCents - 1, Math.round(DEMO_ALL_IN_TARGET_CENTS / (1 + SIMULATED_TAX_RATE)));
  while (price > 0 && allIn(price) > DEMO_ALL_IN_TARGET_CENTS - 100) price -= 1;
  // When the live price already sits under the target, the target-based number is
  // no drop at all, so take a visible step down instead.
  if (price <= 0 || price >= currentCents || price > currentCents * 0.98) {
    price = Math.round(currentCents * 0.94);
  }
  return Math.max(price, 1);
}

async function advance(ctx: MutationCtx, shopperId: Id<"users">, itemId?: Id<"cartItems">) {
  const offer = await demoOffer(ctx, shopperId, itemId);
  const now = Date.now();
  const priceCents = dropPriceFor(offer.priceCents, offer.shippingCents);
  await ctx.db.insert("priceObservations", {
    offerId: offer._id,
    priceCents,
    shippingCents: offer.shippingCents,
    observedAt: now,
    source: DEMO_DROP_SOURCE,
    simulated: true,
  });
  await ctx.db.patch("offers", offer._id, {
    priceCents,
    // A staged demo price is never a live observation.
    simulated: true,
    updatedAt: now,
    provenance: offer.provenance
      ? {
          ...offer.provenance,
          observedAt: now,
          note: "Demo control: a staged price change, not an observation from the retailer",
        }
      : {
          method: "seed",
          sourceUrl: offer.url,
          observedAt: now,
          supportingText: null,
          verifiedKey: null,
          note: "Demo control: a staged price change, not an observation from the retailer",
        },
  });
  await ctx.runMutation(internal.enrichment.refreshPriceHistory, { offerId: offer._id });
  return {
    offerId: offer._id,
    priceCents,
    observedAt: now,
    totalCents: estimateTotals(priceCents, offer.shippingCents, 1).totalCents,
  };
}

/** DEMO CONTROL: writes the later (lower) price observation for the hero offer. */
export const advancePrice = mutation({
  returns: v.object({
    offerId: v.id("offers"),
    priceCents: v.number(),
    observedAt: v.number(),
    totalCents: v.number(),
  }),
  args: { itemId: v.optional(v.id("cartItems")) },
  handler: async (ctx, { itemId }) => {
    const shopperId = await requireShopper(ctx);
    return await advance(ctx, shopperId, itemId);
  },
});

export const advancePriceInternal = internalMutation({
  args: { shopperId: v.id("users"), itemId: v.optional(v.id("cartItems")) },
  handler: async (ctx, { shopperId, itemId }) => advance(ctx, shopperId, itemId),
});

/** Puts the seeded offers back the way demoData.ts describes them. */
async function restoreSeededOffers(ctx: MutationCtx) {
  const now = Date.now();
  for (const product of SEED_PRODUCTS) {
    for (const { history, variantLabel, ...seed } of product.offers) {
      const offer = await ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", seed.canonicalKey))
        .first();
      if (!offer) continue;
      await ctx.db.patch("offers", offer._id, {
        priceCents: seed.priceCents,
        listPriceCents: seed.listPriceCents,
        seller: seed.seller,
        condition: undefined,
        conditionClass: undefined,
        alternates: undefined,
        provenance: undefined,
        simulated: true,
        updatedAt: now,
      });
      const observations = await ctx.db
        .query("priceObservations")
        .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
        .take(500);
      for (const o of observations) await ctx.db.delete("priceObservations", o._id);
      for (const h of history) {
        await ctx.db.insert("priceObservations", {
          offerId: offer._id,
          priceCents: h.priceCents,
          shippingCents: seed.shippingCents,
          observedAt: historyTimestamp(h.daysAgo, now),
          source: "Seeded demo history",
          simulated: true,
        });
      }
    }
  }
}

/** Removes every staged demo drop, whichever offers it touched. */
async function resetPrice(ctx: MutationCtx) {
  const touched = await ctx.db.query("priceObservations").take(2000);
  const offers = new Set<string>();
  for (const o of touched) {
    if (o.source !== DEMO_DROP_SOURCE) continue;
    offers.add(o.offerId);
    await ctx.db.delete("priceObservations", o._id);
  }
  for (const offerId of offers) {
    const offer = await ctx.db.get("offers", offerId as Id<"offers">);
    if (!offer) continue;
    const remaining = await ctx.db
      .query("priceObservations")
      .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
      .take(500);
    const latest = remaining[remaining.length - 1];
    await ctx.db.patch("offers", offer._id, {
      priceCents: latest?.priceCents ?? offer.priceCents,
      updatedAt: Date.now(),
    });
    await ctx.runMutation(internal.enrichment.refreshPriceHistory, { offerId: offer._id });
  }
}

/** DEMO CONTROL: restores the hero price and clears the caller's cart, requests, and orders. */
export const resetDemo = mutation({
  returns: v.null(),
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    await restoreSeededOffers(ctx);
    for (const status of ["active", "purchased", "removed"] as const) {
      const items = await ctx.db
        .query("cartItems")
        .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", status))
        .take(200);
      for (const item of items) {
        const evs = await ctx.db
          .query("evidence")
          .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", item._id))
          .take(10);
        for (const ev of evs) await ctx.db.delete("evidence", ev._id);
        await ctx.db.delete("cartItems", item._id);
      }
    }
    const orders = await ctx.db.query("orders").withIndex("by_shopperId", (q) => q.eq("shopperId", shopperId)).take(200);
    for (const o of orders) {
      const ships = await ctx.db.query("shipments").withIndex("by_orderId", (q) => q.eq("orderId", o._id)).take(5);
      for (const s of ships) await ctx.db.delete("shipments", s._id);
      await ctx.db.delete("orders", o._id);
    }
    for (const status of ["quoting", "pending_approval", "approved", "deferred", "expired", "ordered", "failed"] as const) {
      const reqs = await ctx.db
        .query("purchaseRequests")
        .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", status))
        .take(200);
      for (const r of reqs) await ctx.db.delete("purchaseRequests", r._id);
    }
    return null;
  },
});

/** Creates a shopper row for the agent / CLI demo paths that have no Convex session. */
export const createDemoShopper = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    await ensureCatalog(ctx);
    return await ctx.db.insert("users", { name, isAnonymous: true });
  },
});

export const resetPriceInternal = internalMutation({ args: {}, handler: async (ctx) => { await resetPrice(ctx); return null; } });

/**
 * Cache controls for tests, internal on purpose: these write rows that live
 * shoppers read, so no client may call them. Drive them with `npx convex run`.
 */
export const seedCachedOffer = internalMutation({
  args: {
    url: v.string(),
    priceCents: v.number(),
    title: v.string(),
    seller: v.optional(v.string()),
    ageMs: v.optional(v.number()),
  },
  handler: async (ctx, { url, priceCents, title, seller, ageMs }) => {
    const canonicalKey = canonicalKeyForUrl(url);
    if (!canonicalKey) throw new ConvexError({ code: "INVALID_URL", message: "url must be an http(s) link." });
    const offer = {
      model: title,
      variant: null,
      retailer: null,
      seller: seller ?? "Cached Seller",
      condition: "New",
      priceCents,
      currency: "USD",
      availability: "In stock",
      starRating: 4.6,
      ratingCount: 1200,
      asinOrSku: null,
      imageUrl: null,
      evidence: "seeded cache row for the extraction-cache test",
    };
    const payload = JSON.stringify({ offer, variantMatches: true });
    const fetchedAt = Date.now() - (ageMs ?? 0);
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", "offer").eq("key", canonicalKey))
      .unique();
    if (row) {
      await ctx.db.patch("extractionCache", row._id, {
        payload,
        fetchedAt,
        source: "firecrawl",
        simulated: false,
        attempts: 0,
        lastAttemptAt: fetchedAt,
        pendingStartedAt: undefined,
        invalidatedAt: undefined,
        error: undefined,
      });
      return { key: canonicalKey, attempts: 0 };
    }
    await ctx.db.insert("extractionCache", {
      kind: "offer",
      key: canonicalKey,
      payload,
      fetchedAt,
      source: "firecrawl",
      simulated: false,
      attempts: 0,
      lastAttemptAt: fetchedAt,
    });
    return { key: canonicalKey, attempts: 0 };
  },
});

export const seedCachedQueryResolution = internalMutation({
  args: {
    query: v.string(),
    candidates: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        retailer: v.string(),
        priceCents: v.union(v.number(), v.null()),
      }),
    ),
    ageMs: v.optional(v.number()),
  },
  handler: async (ctx, { query, candidates, ageMs }) => {
    const key = normalizedQuery(query);
    const payload = JSON.stringify({ candidates });
    const fetchedAt = Date.now() - (ageMs ?? 0);
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", "query").eq("key", key))
      .unique();
    if (row) {
      await ctx.db.patch("extractionCache", row._id, {
        payload,
        fetchedAt,
        source: "exa",
        attempts: 0,
        lastAttemptAt: fetchedAt,
        pendingStartedAt: undefined,
        invalidatedAt: undefined,
        error: undefined,
      });
      return { key, attempts: 0 };
    }
    await ctx.db.insert("extractionCache", {
      kind: "query",
      key,
      payload,
      fetchedAt,
      source: "exa",
      simulated: false,
      attempts: 0,
      lastAttemptAt: fetchedAt,
    });
    return { key, attempts: 0 };
  },
});

export const cacheStats = query({
  args: {
    kind: v.union(v.literal("offer"), v.literal("comparison"), v.literal("query"), v.literal("reddit")),
    key: v.string(),
  },
  handler: async (ctx, { kind, key }) => {
    const row = await ctx.db
      .query("extractionCache")
      .withIndex("by_kind_and_key", (q) => q.eq("kind", kind).eq("key", key))
      .unique();
    if (!row) return null;
    return {
      attempts: row.attempts,
      fetchedAt: row.fetchedAt,
      hasPayload: Boolean(row.payload),
      source: row.source,
      error: row.error ?? null,
    };
  },
});
