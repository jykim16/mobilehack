/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import { resolveImageUrl, sameVariant } from "./lib/firecrawlExtract";
import { canonicalKeyForUrl } from "./lib/urls";
import { fetchOpenGraph, parseOpenGraph } from "./lib/opengraph";
import { getItemFor } from "./model/cart";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const url = "https://www.amazon.com/dp/B0FQFB8FMG";
const image = "https://m.media-amazon.com/images/I/61solmQSSlL._AC_SL1500_.jpg";
const html = `<title>Apple AirPods Pro 3</title><input id="ASIN" value="B0FQFB8FMG"><img src="https://example.com/recommendation.jpg"><img src="/small.jpg" data-old-hires="${image}" id="landingImage">`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function seed(imageUrl?: string) {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
    const productId = await ctx.db.insert("products", { title: "AirPods Pro 3", category: "general", imageUrl });
    const variantId = await ctx.db.insert("variants", { productId, label: "White" });
    const offerId = await ctx.db.insert("offers", {
      productId, variantId, retailer: "amazon", retailerName: "Amazon", seller: "Amazon",
      url, canonicalKey: "amazon:B0FQFB8FMG", priceCents: 0, shippingCents: 0, currency: "USD",
      deliveryEstimate: "Unknown", returnSummary: "See retailer", inStock: false, simulated: true, updatedAt: 1,
    });
    const cartItemId = await ctx.db.insert("cartItems", {
      shopperId, productId, variantId, offerId, url, quantity: 1, addedBy: "app", status: "active",
      enrichmentStatus: "partial", idempotencyKey: "airpods", addedAt: 1,
    });
    return { shopperId, productId, variantId, offerId, cartItemId };
  });
  return { t, ...ids };
}

describe("exact listing image fallback", () => {
  test("normalizes mobile ASINs once and requires exact extracted identifiers", () => {
    expect(canonicalKeyForUrl("https://www.amazon.com/gp/aw/d/B0FQFB8FMG")).toBe("amazon:B0FQFB8FMG");
    expect(sameVariant("amazon:amazon.com/gp/aw/d/B0FQFB8FMG", "B0D1XD1ZV3")).toBe(false);
    expect(sameVariant("amazon:B0FQFB8FMG", "B0FQFB8FMG-extra")).toBe(false);
    expect(sameVariant("amazon:B0FQFB8FMG", null)).toBe(false);
    expect(sameVariant("amazon:B0FQFB8FMG", "B0FQFB8FMG")).toBe(true);
  });
  test("extracts Amazon's main image without OpenGraph metadata or a price", () => {
    expect(parseOpenGraph(html, url)).toMatchObject({ image, title: "Apple AirPods Pro 3" });
    expect(parseOpenGraph(html, url).priceCents).toBeUndefined();
  });

  test("never substitutes a recommendation or a different ASIN", () => {
    expect(parseOpenGraph(html.replace('id="landingImage"', 'id="recommendation"'), url).image).toBeUndefined();
    expect(parseOpenGraph(html.replace('value="B0FQFB8FMG"', 'value="B0D1XD1ZV3"'), url).image).toBeUndefined();
  });

  test("supports quoted attributes and relative OpenGraph images", () => {
    expect(parseOpenGraph(`<meta content='/image.jpg?a=1&amp;b=2' property='og:image'>`, "https://shop.example/item").image)
      .toBe("https://shop.example/image.jpg?a=1&b=2");
    expect(parseOpenGraph(`<input value='B0FQFB8FMG' id='ASIN'><img id='imgBlkFront' data-a-hires='${image}'>`, url).image).toBe(image);
  });

  test.each(["data:image/png;base64,AA", "javascript:alert(1)", "file:///image.jpg", "https://user:pass@example.com/image.jpg", " "])("rejects unsafe image URL %s", (value) => {
    expect(resolveImageUrl(value, url)).toBeNull();
  });

  test("rejects a fetch redirected to another listing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, url: "https://www.amazon.com/dp/B0D1XD1ZV3", text: async () => html }));
    expect(await fetchOpenGraph(url)).toEqual({});
  });

  test("accepts a mobile listing and its redirect to the same ASIN", async () => {
    const mobileUrl = "https://www.amazon.com/gp/aw/d/B0FQFB8FMG/ref=mobile";
    expect(parseOpenGraph(html, mobileUrl)).toMatchObject({ image, title: "Apple AirPods Pro 3" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, url, text: async () => html }));
    expect(await fetchOpenGraph(mobileUrl)).toMatchObject({ image, title: "Apple AirPods Pro 3" });
  });

  test("rejects a mobile listing redirected to a different ASIN", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, url: "https://www.amazon.com/dp/B0D1XD1ZV3", text: async () => html }));
    expect(await fetchOpenGraph("https://www.amazon.com/gp/aw/d/B0FQFB8FMG")).toEqual({});
  });
});

describe("image-only repair", () => {
  test.each(["B0FQFB8FMG", "B0D1XD1ZV3"])("initial mobile resolution preserves only the matching no-price image %s when OG fails", async (asin) => {
    vi.useFakeTimers();
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
    const { t, cartItemId } = await seed();
    const mobileUrl = "https://www.amazon.com/gp/aw/d/B0FQFB8FMG";
    await t.run((ctx) => ctx.db.patch("cartItems", cartItemId, { url: mobileUrl, productId: undefined, variantId: undefined, offerId: undefined }));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (!init?.body) throw new Error("OpenGraph unavailable");
      return new Response(JSON.stringify({ data: { metadata: { sourceURL: url }, json: { asinOrSku: asin, imageUrl: image, displayedPrice: null } } }));
    }));
    await t.action(internal.enrichment.resolveOffer, { cartItemId });
    const context = await t.query(internal.enrichment.getSectionContext, { cartItemId });
    expect(context?.product.imageUrl).toBe(asin === "B0FQFB8FMG" ? image : undefined);
    expect(context?.offer.priceCents).toBe(0);
  });

  test.each(["B0FQFB8FMG", "B0D1XD1ZV3"])("mobile no-price extraction with desktop redirect validates ASIN %s", async (asin) => {
    vi.useFakeTimers();
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
    const { t, cartItemId, productId, offerId } = await seed();
    const mobileUrl = "https://www.amazon.com/gp/aw/d/B0FQFB8FMG";
    await t.run(async (ctx) => {
      await ctx.db.patch("cartItems", cartItemId, { url: mobileUrl });
      await ctx.db.patch("offers", offerId, { url: mobileUrl, canonicalKey: "amazon:amazon.com/gp/aw/d/B0FQFB8FMG" });
    });
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      if (!init?.body) throw new Error("OpenGraph unavailable");
      const request = JSON.parse(init.body);
      return new Response(JSON.stringify({ data: { metadata: { sourceURL: request.url.includes("/gp/aw/d/") ? url : request.url }, json:
        request.url === mobileUrl ? { asinOrSku: asin, imageUrl: image, displayedPrice: null } : {} } }));
    }));
    await t.action(internal.enrichment.enrichOfferFromWeb, { cartItemId });
    const product = await t.run((ctx) => ctx.db.get("products", productId));
    expect(product?.imageUrl).toBe(asin === "B0FQFB8FMG" ? image : undefined);
    expect((await t.run((ctx) => ctx.db.get("offers", offerId)))?.priceCents).toBe(0);
  });

  test("rejects wrong-ASIN cached image despite a cached true match flag", async () => {
    const { t, cartItemId, productId, offerId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.patch("offers", offerId, { url: "https://www.amazon.com/gp/aw/d/B0FQFB8FMG" });
      await ctx.db.insert("extractionCache", {
        kind: "offer", key: "amazon:B0FQFB8FMG", source: "firecrawl", simulated: false, attempts: 1, fetchedAt: 1,
        payload: JSON.stringify({ variantMatches: true, offer: { imageUrl: image, asinOrSku: "B0D1XD1ZV3" } }),
      });
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("unavailable")));
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get("products", productId)))?.imageUrl).toBeUndefined();
  });

  test("fetches selected offer rather than original item URL", async () => {
    const { t, cartItemId } = await seed();
    await t.run((ctx) => ctx.db.patch("cartItems", cartItemId, { url: "https://www.amazon.com/dp/B0D1XD1ZV3" }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html)));
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBe(image);
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe(url);
  });

  test("declines product-level image repair for sibling variants", async () => {
    const { t, cartItemId, productId, offerId, variantId } = await seed();
    await t.run((ctx) => ctx.db.insert("variants", { productId, label: "Black" }));
    vi.stubGlobal("fetch", vi.fn());
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBeNull();
    expect(await t.mutation(internal.productImages.applyMissing, { cartItemId, productId, offerId, variantId, sourceUrl: url, imageUrl: image })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect((await t.run((ctx) => ctx.db.get("products", productId)))?.imageUrl).toBeUndefined();
  });

  test("rejects a stale repair after selected offer changes during fetch", async () => {
    const { t, cartItemId, productId, offerId } = await seed();
    const nextOffer = await t.run(async (ctx) => {
      const offer = (await ctx.db.get("offers", offerId))!;
      const { _id, _creationTime, ...fields } = offer;
      return await ctx.db.insert("offers", { ...fields, url: "https://www.amazon.com/dp/B0D1XD1ZV3", canonicalKey: "amazon:B0D1XD1ZV3" });
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      await t.run((ctx) => ctx.db.patch("cartItems", cartItemId, { offerId: nextOffer }));
      return new Response(html);
    }));
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get("products", productId)))?.imageUrl).toBeUndefined();
  });

  test("rejects a stale repair after variant changes on the same offer", async () => {
    const { t, cartItemId, productId, offerId, variantId } = await seed();
    vi.stubGlobal("fetch", vi.fn(async () => {
      await t.run(async (ctx) => {
        await ctx.db.delete("variants", variantId);
        const nextVariant = await ctx.db.insert("variants", { productId, label: "Black" });
        await ctx.db.patch("offers", offerId, { variantId: nextVariant });
        await ctx.db.patch("cartItems", cartItemId, { variantId: nextVariant });
      });
      return new Response(html);
    }));
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBeNull();
    expect((await t.run((ctx) => ctx.db.get("products", productId)))?.imageUrl).toBeUndefined();
  });

  test("fills missing image while leaving offer, price and variant identical", async () => {
    const { t, shopperId, cartItemId, productId, offerId, variantId } = await seed();
    const before = await t.run(async (ctx) => ({ offer: await ctx.db.get("offers", offerId), variant: await ctx.db.get("variants", variantId) }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(html)));
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBe(image);
    const after = await t.run(async (ctx) => ({ offer: await ctx.db.get("offers", offerId), variant: await ctx.db.get("variants", variantId), product: await ctx.db.get("products", productId) }));
    expect(after.offer).toEqual(before.offer);
    expect(after.variant).toEqual(before.variant);
    expect(after.product?.imageUrl).toBe(image);
    const payload = await t.run((ctx) => getItemFor(ctx, shopperId, cartItemId));
    expect(payload.product?.imageUrl).toBe(image);
    expect(payload.offer?.priceCents).toBe(before.offer?.priceCents);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("preserves existing images without fetching", async () => {
    const { t, cartItemId, productId, offerId, variantId } = await seed("https://example.com/good.jpg");
    vi.stubGlobal("fetch", vi.fn());
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBe("https://example.com/good.jpg");
    expect(await t.mutation(internal.productImages.applyMissing, { cartItemId, productId, offerId, variantId, imageUrl: image, sourceUrl: url })).toBe("https://example.com/good.jpg");
    expect(fetch).not.toHaveBeenCalled();
  });

  test("uses exact-variant cached image without calling a provider", async () => {
    const { t, cartItemId } = await seed();
    await t.run(async (ctx) => {
      await ctx.db.insert("extractionCache", {
        kind: "offer", key: "amazon:B0FQFB8FMG", source: "firecrawl", simulated: false, attempts: 1, fetchedAt: 1,
        payload: JSON.stringify({ variantMatches: true, offer: { imageUrl: image, asinOrSku: "B0FQFB8FMG" } }),
      });
    });
    vi.stubGlobal("fetch", vi.fn());
    expect(await t.action(internal.productImages.refreshMissing, { cartItemId })).toBe(image);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("rejects cross-listing repairs and unsafe URLs", async () => {
    const { t, cartItemId, productId, offerId, variantId } = await seed();
    expect(await t.mutation(internal.productImages.applyMissing, { cartItemId, productId, offerId, variantId, imageUrl: image, sourceUrl: "https://www.amazon.com/dp/B0D1XD1ZV3" })).toBeNull();
    expect(await t.mutation(internal.productImages.applyMissing, { cartItemId, productId, offerId, variantId, imageUrl: "data:image/png;base64,AA", sourceUrl: url })).toBeNull();
    expect(await t.run((ctx) => ctx.db.get("products", productId))).not.toHaveProperty("imageUrl");
  });

  test("retains a Firecrawl listing image even when price extraction fails", async () => {
    vi.useFakeTimers();
    vi.stubEnv("FIRECRAWL_API_KEY", "test-key");
    const { t, cartItemId, productId, offerId } = await seed();
    const before = await t.run((ctx) => ctx.db.get("offers", offerId));
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const request = JSON.parse(init.body);
      const isOffer = request.url === url;
      return new Response(JSON.stringify({ success: true, data: { metadata: { sourceURL: request.url }, json: isOffer
        ? { model: "AirPods Pro 3", asinOrSku: "B0FQFB8FMG", imageUrl: image, displayedPrice: null }
        : {} } }));
    }));
    await t.action(internal.enrichment.enrichOfferFromWeb, { cartItemId });
    const after = await t.run((ctx) => ctx.db.get("offers", offerId));
    expect(after?.priceCents).toBe(before?.priceCents);
    expect(after?.variantId).toBe(before?.variantId);
    expect(await t.run((ctx) => ctx.db.get("products", productId))).toHaveProperty("imageUrl", image);
  });
});
