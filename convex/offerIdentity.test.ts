import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import type { Id } from "./_generated/dataModel";
import { cartItemView } from "./model/views";
import { createRequestFor } from "./model/purchases";

const modules = import.meta.glob("./**/*.ts");

type OfferSeed = {
  variant: "Black" | "White";
  retailer: string;
  retailerName: string;
  seller: string;
  url: string;
  priceCents: number;
  currency: string;
  condition: string;
  conditionClass: "new" | "used" | "refurbished" | "unknown";
};

const SEED_OFFERS: OfferSeed[] = [
  {
    variant: "Black",
    retailer: "amazon",
    retailerName: "Amazon",
    seller: "Amazon Renewed",
    url: "https://www.amazon.com/dp/B0IDENTA01",
    priceCents: 4000,
    currency: "USD",
    condition: "Used - Very Good",
    conditionClass: "used",
  },
  {
    variant: "Black",
    retailer: "amazon",
    retailerName: "Amazon",
    seller: "Amazon.com",
    url: "https://www.amazon.com/dp/B0IDENTA02",
    priceCents: 3800,
    currency: "USD",
    condition: "New",
    conditionClass: "new",
  },
  {
    variant: "White",
    retailer: "amazon",
    retailerName: "Amazon",
    seller: "Amazon.com",
    url: "https://www.amazon.com/dp/B0IDENTA03",
    priceCents: 2500,
    currency: "USD",
    condition: "New",
    conditionClass: "new",
  },
  {
    variant: "Black",
    retailer: "amazon",
    retailerName: "Amazon",
    seller: "Amazon.com",
    url: "https://www.amazon.com/dp/B0IDENTA04",
    priceCents: 3000,
    currency: "CAD",
    condition: "New",
    conditionClass: "new",
  },
  {
    variant: "Black",
    retailer: "bestbuy",
    retailerName: "Best Buy",
    seller: "Best Buy",
    url: "https://www.bestbuy.com/site/fixture-identity-a/6505727.p",
    priceCents: 2800,
    currency: "USD",
    condition: "New",
    conditionClass: "new",
  },
];

const SAVED = 0;
const EXACT_NEW = 1;
const WHITE_NEW = 2;
const OTHER_CURRENCY = 3;
const OTHER_STORE = 4;

async function seed(offers: OfferSeed[] = SEED_OFFERS, options: { withSavedVariant?: boolean } = {}) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
    const productId = await ctx.db.insert("products", { title: "Fixture headphones", category: "headphones" });
    const variantIds = {
      Black: await ctx.db.insert("variants", { productId, label: "Black" }),
      White: await ctx.db.insert("variants", { productId, label: "White" }),
    };
    const offerIds: Id<"offers">[] = [];
    for (const [index, o] of offers.entries()) {
      offerIds.push(
        await ctx.db.insert("offers", {
          productId,
          variantId: variantIds[o.variant],
          retailer: o.retailer,
          retailerName: o.retailerName,
          seller: o.seller,
          url: o.url,
          canonicalKey: `fixture-${index}`,
          priceCents: o.priceCents,
          shippingCents: 0,
          currency: o.currency,
          deliveryEstimate: "3-5 days",
          returnSummary: "30 day returns",
          condition: o.condition,
          conditionClass: o.conditionClass,
          inStock: true,
          simulated: true,
          updatedAt: Date.now(),
        }),
      );
    }
    const itemId = await ctx.db.insert("cartItems", {
      shopperId,
      url: offers[0].url,
      productId,
      variantId: options.withSavedVariant === false ? undefined : variantIds[offers[0].variant],
      offerId: offerIds[0],
      quantity: 1,
      addedBy: "app",
      status: "active",
      enrichmentStatus: "ready",
      idempotencyKey: "identity-fixture",
      addedAt: Date.now(),
    });
    const item = (await ctx.db.get("cartItems", itemId))!;
    return { shopperId, item, offerIds, view: await cartItemView(ctx, item, "full") };
  });
  return { t, ...ids };
}

describe("offer identity binding", () => {
  test("a cheaper new offer of another variant never stands in for the saved used offer", async () => {
    const { view, offerIds } = await seed();
    expect(view.offer?.id).toBe(offerIds[SAVED]);
    expect(view.offer?.conditionClass).toBe("used");
    expect(view.offer?.priceCents).toBe(4000);
    expect(view.newOffer?.id).toBe(offerIds[EXACT_NEW]);
    expect(view.newOffer?.priceCents).toBe(3800);
    expect(view.offerAvailability.identityVerified).toBe(true);
    expect(view.offerAvailability.checkoutEligible).toBe(true);
  });

  test("the other variant is exposed as an explicit alternative, labeled", async () => {
    const { view, offerIds } = await seed();
    const white = view.alternatives.find((a) => a.offerId === offerIds[WHITE_NEW]);
    expect(white).toMatchObject({
      variantLabel: "White",
      priceCents: 2500,
      sameVariant: false,
      sameRetailer: true,
      sameCurrency: true,
      reason: "A different variant of this product",
    });
    expect(view.newOffer?.variantId).not.toBe(white?.variantId);
  });

  test("a same-variant offer in another currency is an alternative, not the price", async () => {
    const { view, offerIds } = await seed();
    const cad = view.alternatives.find((a) => a.offerId === offerIds[OTHER_CURRENCY]);
    expect(cad).toMatchObject({ currency: "CAD", sameVariant: true, sameCurrency: false, reason: "A different currency" });
    expect(view.newOffer?.currency).toBe("USD");
  });

  test("a same-variant offer from another store is an alternative, not the price", async () => {
    const { view, offerIds } = await seed();
    const store = view.alternatives.find((a) => a.offerId === offerIds[OTHER_STORE]);
    expect(store).toMatchObject({ retailer: "bestbuy", sameRetailer: false, reason: "A different store" });
    expect(view.newOffer?.retailer).toBe("amazon");
  });

  test("no stand-in is invented when nothing shares the saved identity", async () => {
    const altOnly = SEED_OFFERS.filter((_, i) => i !== EXACT_NEW);
    const { view } = await seed(altOnly, { withSavedVariant: true });
    expect(view.newOffer).toBeNull();
    expect(view.offer?.conditionClass).toBe("used");
    expect(view.offerAvailability.newOfferAvailable).toBe(false);
    expect(view.offerAvailability.identityVerified).toBe(true);
    expect(view.offerAvailability.checkoutEligible).toBe(false);
    expect(view.alternatives.length).toBe(3);
  });

  test("an unknown identity fails closed", async () => {
    const { view } = await seed(SEED_OFFERS, { withSavedVariant: false });
    expect(view.offerAvailability.identityVerified).toBe(false);
    expect(view.offerAvailability.checkoutEligible).toBe(false);
    expect(view.newOffer).toBeNull();
  });
});

describe("checkout identity guard", () => {
  const request = (
    t: ReturnType<typeof convexTest>,
    shopperId: Id<"users">,
    itemId: Id<"cartItems">,
    offerId: Id<"offers">,
    key: string,
  ) =>
    t.run(async (ctx) =>
      createRequestFor(ctx, shopperId, { itemId, offerId, quantity: 1, reason: "Test", idempotencyKey: key }, "app"),
    );

  test.each([
    ["a different variant", WHITE_NEW],
    ["a different currency", OTHER_CURRENCY],
    ["a different store", OTHER_STORE],
  ])("refuses %s", async (_label, index) => {
    const { t, shopperId, item, offerIds } = await seed();
    await expect(request(t, shopperId, item._id, offerIds[index], `identity-${index}`)).rejects.toMatchObject({
      data: { code: "OFFER_IDENTITY_MISMATCH" },
    });
    const requests = await t.run(async (ctx) => ctx.db.query("purchaseRequests").collect());
    expect(requests).toHaveLength(0);
  });

  test("accepts the same-identity new offer", async () => {
    const { t, shopperId, item, offerIds } = await seed();
    const requestId = await request(t, shopperId, item._id, offerIds[EXACT_NEW], "identity-exact");
    const row = await t.run(async (ctx) => ctx.db.get("purchaseRequests", requestId));
    expect(row?.offerId).toBe(offerIds[EXACT_NEW]);
  });

  test("the saved offer passes the identity check and is refused only for its condition", async () => {
    const { t, shopperId, item, offerIds } = await seed();
    await expect(request(t, shopperId, item._id, offerIds[SAVED], "identity-saved")).rejects.toMatchObject({
      data: { code: "OFFER_UNAVAILABLE" },
    });
  });

  test("refuses an item whose saved identity is unknown", async () => {
    const { t, shopperId, item, offerIds } = await seed(SEED_OFFERS, { withSavedVariant: false });
    await expect(request(t, shopperId, item._id, offerIds[SAVED], "identity-unknown")).rejects.toMatchObject({
      data: { code: "OFFER_IDENTITY_MISMATCH" },
    });
  });
});
