import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { HERO_ASIN, HERO_INITIAL_PRICE_CENTS, HERO_URL, SEED_PRODUCTS } from "./lib/demoData";

const modules = import.meta.glob("./**/*.ts");

async function seeded() {
  const t = convexTest(schema, modules);
  await t.mutation(internal.demo.seedCatalog, {});
  return t;
}

describe("the seeded Sony hero listing", () => {
  test("carries the price the user reported for this exact listing", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    expect(HERO_INITIAL_PRICE_CENTS).toBe(19499);
    expect(offer?.priceCents).toBe(19499);
    expect(offer?.url).toBe(HERO_URL);
    expect(offer?.simulated).toBe(true);
  });

  test("says the price is user-reported and unverified rather than presenting it as a live read", async () => {
    const t = await seeded();
    const offer = await t.run(async (ctx) =>
      ctx.db
        .query("offers")
        .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", `amazon:${HERO_ASIN}`))
        .first(),
    );
    expect(offer?.provenance?.method).toBe("seed");
    expect(offer?.provenance?.sourceUrl).toBe(HERO_URL);
    expect(offer?.provenance?.note).toContain("reported by the user");
    expect(offer?.provenance?.note).toContain("Not independently verified");
  });

  test("keeps the Black variant purchasable and the other variant untouched", async () => {
    const t = await seeded();
    const rows = await t.run(async (ctx) => {
      const offers = await ctx.db.query("offers").collect();
      const variants = await ctx.db.query("variants").collect();
      return offers.map((o) => ({
        key: o.canonicalKey,
        price: o.priceCents,
        conditionClass: o.conditionClass,
        variant: variants.find((v) => v._id === o.variantId)?.label,
      }));
    });
    const black = rows.find((r) => r.key === `amazon:${HERO_ASIN}`);
    const silver = rows.find((r) => r.key === "amazon:B09Y2MYL5C");
    expect(black).toMatchObject({ price: 19499, variant: "Black" });
    expect(black?.conditionClass).toBeUndefined();
    expect(silver).toMatchObject({ price: 29999, variant: "Silver" });
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

  test("the seed offers are the single source the demo reset restores from", async () => {
    const t = await seeded();
    const keys = await t.run(async (ctx) => (await ctx.db.query("offers").collect()).map((o) => [o.canonicalKey, o.priceCents]));
    const fromSeed = SEED_PRODUCTS.flatMap((p) => p.offers.map((o) => [o.canonicalKey, o.priceCents]));
    for (const [key, price] of fromSeed) {
      expect(keys).toContainEqual([key, price]);
    }
  });
});
