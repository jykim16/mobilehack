import { v } from "convex/values";
import { internalMutation, mutation, type MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireShopper } from "./lib/auth";
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

async function heroOffer(ctx: MutationCtx) {
  await ensureCatalog(ctx);
  return (await ctx.db
    .query("offers")
    .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
    .first())!;
}

export const seedCatalog = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ensureCatalog(ctx);
    return { heroUrl: HERO_URL, airflyUrl: AIRFLY_URL };
  },
});

/** Seeds the catalog and puts the second-retailer item (Best Buy AirFly Pro) in the caller's cart. */
export const setupMyCart = mutation({
  returns: v.object({ heroUrl: v.string(), airflyItemId: v.id("cartItems") }),
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    await ensureCatalog(ctx);
    const airfly = await addItemFor(
      ctx,
      shopperId,
      { url: AIRFLY_URL, reason: "Use wireless headphones with seatback entertainment", idempotencyKey: "demo-airfly" },
      "app",
    );
    return { heroUrl: HERO_URL, airflyItemId: airfly.itemId };
  },
});

/** $250 all-in target the demo price drop aims under. */
const DEMO_ALL_IN_TARGET_CENTS = 25000;

/** Largest item price whose all-in total still lands at or under the target. */
function dropPriceFor(currentCents: number, shippingCents: number): number {
  const allIn = (price: number) => estimateTotals(price, shippingCents, 1).totalCents;
  let price = Math.min(currentCents - 1, Math.round(DEMO_ALL_IN_TARGET_CENTS / (1 + SIMULATED_TAX_RATE)));
  while (price > 0 && allIn(price) > DEMO_ALL_IN_TARGET_CENTS - 100) price -= 1;
  if (price <= 0 || price >= currentCents) price = Math.round(currentCents * 0.94);
  return Math.max(price, 1);
}

async function advance(ctx: MutationCtx) {
  const offer = await heroOffer(ctx);
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
  return { offerId: offer._id, priceCents, observedAt: now };
}

/** DEMO CONTROL: writes the later (lower) price observation for the hero offer. */
export const advancePrice = mutation({
  returns: v.object({
    offerId: v.id("offers"),
    priceCents: v.number(),
    observedAt: v.number(),
  }),
  args: {},
  handler: async (ctx) => {
    await requireShopper(ctx);
    return await advance(ctx);
  },
});

export const advancePriceInternal = internalMutation({ args: {}, handler: async (ctx) => advance(ctx) });

async function resetPrice(ctx: MutationCtx) {
  const offer = await heroOffer(ctx);
  const obs = await ctx.db
    .query("priceObservations")
    .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
    .take(500);
  for (const o of obs) if (o.source === DEMO_DROP_SOURCE) await ctx.db.delete("priceObservations", o._id);
  await ctx.db.patch("offers", offer._id, { priceCents: HERO_INITIAL_PRICE_CENTS, updatedAt: Date.now() });
  await ctx.runMutation(internal.enrichment.refreshPriceHistory, { offerId: offer._id });
}

/** DEMO CONTROL: restores the hero price and clears the caller's cart, requests, and orders. */
export const resetDemo = mutation({
  returns: v.null(),
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    await resetPrice(ctx);
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

