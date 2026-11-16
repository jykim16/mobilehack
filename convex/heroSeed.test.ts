import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import {
  HERO_ASIN,
  HERO_OBSERVED_PRICE_CENTS,
  HERO_URL,
  SEED_PRODUCTS,
  USER_REPORTED_PRICE_CENTS,
} from "./lib/demoData";
import { cartItemView } from "./model/views";
import { createRequestFor } from "./model/purchases";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.demo.seedCatalog, {});
  return t;
}


describe("the seeded Sony hero listing", () => {
  test("stores the offer the live page actually shows", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    expect(HERO_OBSERVED_PRICE_CENTS).toBe(18810);
    expect(offer?.priceCents).toBe(18810);
    expect(offer?.url).toBe(HERO_URL);
    expect(offer?.seller).toBe("Amazon Resale");
    expect(offer?.condition).toBe("Used - Like New");
    expect(offer?.conditionClass).toBe("used");
  });

  test("says where the price came from instead of presenting it as a verified new offer", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    expect(offer?.provenance?.method).toBe("seed");
    expect(offer?.provenance?.sourceUrl).toBe(HERO_URL);
    expect(offer?.provenance?.note).toContain("Read from the live listing");
    expect(offer?.provenance?.note).toContain("$188.10");
    expect(offer?.provenance?.note).toContain("$194.99");
  });

  test("keeps the user-reported price and the live read as separate, source-labeled observations", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    const points = await t.run(async (ctx) =>
      ctx.db
        .query("priceObservations")
        .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer!._id))
        .collect(),
    );
    const reported = points.find((p) => p.priceCents === USER_REPORTED_PRICE_CENTS);
    const read = points.find((p) => p.priceCents === HERO_OBSERVED_PRICE_CENTS && !p.simulated);
    expect(USER_REPORTED_PRICE_CENTS).toBe(19499);
    expect(reported?.source).toContain("User-reported");
    expect(reported?.source).toContain("not confirmed");
    expect(reported?.simulated).toBe(false);
    expect(read?.source).toContain("Live page read");
    expect(read?.source).toContain("Amazon Resale");
    expect(read?.simulated).toBe(false);
    expect(points.some((p) => p.simulated)).toBe(true);
  });

  test("does not attach the user's price to the resale seller's condition", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    const sixDay = await t.run(async (ctx) =>
      ctx.db
        .query("priceObservations")
        .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer!._id))
        .collect(),
    );
    expect(sixDay.every((p) => p.priceCents !== 27999)).toBe(true);
    expect(offer?.condition).toBe("Used - Like New");
  });

  test("the hero item reports unavailable rather than a substituted new price", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    const view = await t.run(async (ctx) => {
      const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
      const itemId = await ctx.db.insert("cartItems", {
        shopperId,
        url: HERO_URL,
        productId: offer!.productId,
        variantId: offer!.variantId,
        offerId: offer!._id,
        quantity: 1,
        addedBy: "app",
        status: "active",
        enrichmentStatus: "ready",
        idempotencyKey: "hero-identity",
        addedAt: Date.now(),
      });
      return cartItemView(ctx, (await ctx.db.get("cartItems", itemId))!, "full");
    });
    expect(view.offer?.conditionClass).toBe("used");
    expect(view.offer?.seller).toBe("Amazon Resale");
    // The item view's own substitution guard is the offer-identity PR; this one
    // proves the stored offer itself no longer claims to be a new Amazon.com unit.
    expect(view.offer?.priceCents).toBe(18810);
  });

  test("checkout has no hero bypass: only a new-condition offer can be requested", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    const row = await t.run(async (ctx) => {
      const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
      const itemId = await ctx.db.insert("cartItems", {
        shopperId,
        url: HERO_URL,
        productId: offer!.productId,
        variantId: offer!.variantId,
        offerId: offer!._id,
        quantity: 1,
        addedBy: "app",
        status: "active",
        enrichmentStatus: "ready",
        idempotencyKey: "hero-che",
        addedAt: Date.now(),
      });
      return { shopperId, itemId };
    });
    await expect(
      t.run(async (ctx) =>
        createRequestFor(ctx, row.shopperId, { itemId: row.itemId, offerId: offer!._id, quantity: 1, reason: "T", idempotencyKey: "hero-key" }, "app"),
      ),
    ).rejects.toMatchObject({ data: { code: "OFFER_UNAVAILABLE" } });
  });

  test("describes the product with the listing's own feature text", async () => {
    const t = await seeded();
    const product = await t.run(async (ctx) =>
      ctx.db
        .query("products")
        .withIndex("by_demoKey", (q) => q.eq("demoKey", "hero-xm5"))
        .unique(),
    );
    expect(product?.description).toContain("Auto NC Optimizer");
    expect(product?.description).toContain("up to 30 hrs of battery");
    expect(product?.description).not.toContain("adaptive noise canceling");
  });

  test("the seed offers are the single source the reseed applies", async () => {
    const t = await seeded();
    const keys = await t.run(async (ctx) => (await ctx.db.query("offers").collect()).map((o) => [o.canonicalKey, o.priceCents]));
    for (const [key, price] of SEED_PRODUCTS.flatMap((p) => p.offers.map((o) => [o.canonicalKey, o.priceCents] as const))) {
      expect(keys).toContainEqual([key, price]);
    }
  });
});

describe("reseedOffersInternal", () => {
  test("brings deployed seed rows in line without touching a shopper's cart", async () => {
    const t = await seeded();
    const before = await t.run(async (ctx) => {
      const offer = await ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first();
      await ctx.db.patch("offers", offer!._id, { priceCents: 27999, seller: "Amazon.com", condition: undefined, conditionClass: undefined, provenance: undefined });
      const product = await ctx.db
        .query("products")
        .withIndex("by_demoKey", (q) => q.eq("demoKey", "hero-xm5"))
        .unique();
      await ctx.db.patch("products", product!._id, { description: "stale text" });
      const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
      const itemId = await ctx.db.insert("cartItems", {
        shopperId,
        url: HERO_URL,
        productId: offer!.productId,
        variantId: offer!.variantId,
        offerId: offer!._id,
        quantity: 2,
        addedBy: "app",
        status: "active",
        enrichmentStatus: "ready",
        idempotencyKey: "kept-item",
        addedAt: Date.now(),
      });
      return { itemId };
    });

    await t.mutation(internal.demo.reseedOffersInternal, {});

    const after = await t.run(async (ctx) => {
      const offer = await ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first();
      const item = await ctx.db.get("cartItems", before.itemId);
      const product = await ctx.db
        .query("products")
        .withIndex("by_demoKey", (q) => q.eq("demoKey", "hero-xm5"))
        .unique();
      return { price: offer?.priceCents, seller: offer?.seller, conditionClass: offer?.conditionClass, note: offer?.provenance?.note, item, description: product?.description };
    });
    expect(after.price).toBe(18810);
    expect(after.seller).toBe("Amazon Resale");
    expect(after.conditionClass).toBe("used");
    expect(after.note).toContain("Read from the live listing");
    expect(after.description).toContain("Auto NC Optimizer");
    expect(after.item).not.toBeNull();
    expect(after.item?.status).toBe("active");
    expect(after.item?.quantity).toBe(2);
  });
});
