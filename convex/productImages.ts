import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { resolveImageUrl, sameVariant } from "./lib/firecrawlExtract";
import { fetchOpenGraph } from "./lib/opengraph";
import { canonicalKeyForUrl } from "./lib/urls";

async function imageContext(ctx: QueryCtx, cartItemId: Id<"cartItems">) {
  const item = await ctx.db.get("cartItems", cartItemId);
  if (!item?.productId || !item.variantId || !item.offerId) return null;
  const offer = await ctx.db.get("offers", item.offerId);
  const product = await ctx.db.get("products", item.productId);
  const variants = await ctx.db.query("variants").withIndex("by_productId", (q) => q.eq("productId", item.productId!)).take(2);
  if (!offer || !product || offer.productId !== item.productId || offer.variantId !== item.variantId ||
    variants.length !== 1 || variants[0]._id !== item.variantId) return null;
  return { productId: product._id, offerId: offer._id, variantId: item.variantId, url: offer.url, imageUrl: product.imageUrl ?? null };
}

export const getContext = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  returns: v.union(v.null(), v.object({
    productId: v.id("products"), offerId: v.id("offers"), variantId: v.id("variants"), url: v.string(), imageUrl: v.union(v.string(), v.null()),
  })),
  handler: (ctx, { cartItemId }) => imageContext(ctx, cartItemId),
});

export const applyMissing = internalMutation({
  args: {
    cartItemId: v.id("cartItems"), productId: v.id("products"), offerId: v.id("offers"), variantId: v.id("variants"),
    imageUrl: v.string(), sourceUrl: v.string(),
  },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { cartItemId, productId, offerId, variantId, imageUrl, sourceUrl }) => {
    const data = await imageContext(ctx, cartItemId);
    const sourceKey = canonicalKeyForUrl(sourceUrl);
    if (!data || !sourceKey || data.productId !== productId || data.offerId !== offerId || data.variantId !== variantId ||
      sourceKey !== canonicalKeyForUrl(data.url)) return null;
    if (data.imageUrl) return data.imageUrl;
    const image = resolveImageUrl(imageUrl, sourceUrl);
    if (!image) return null;
    await ctx.db.patch("products", productId, { imageUrl: image });
    return image;
  },
});

export const refreshMissing = internalAction({
  args: { cartItemId: v.id("cartItems") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { cartItemId }): Promise<string | null> => {
    const data = await ctx.runQuery(internal.productImages.getContext, { cartItemId });
    if (!data || data.imageUrl) return data?.imageUrl ?? null;
    const key = canonicalKeyForUrl(data.url);
    if (!key) return null;
    const cached = await ctx.runQuery(internal.cache.read, { kind: "offer", key });
    let image: string | null = null;
    if (cached?.payload) {
      try {
        const payload = JSON.parse(cached.payload);
        if (payload.variantMatches === true && sameVariant(key, payload.offer?.asinOrSku ?? null)) {
          image = resolveImageUrl(typeof payload.offer?.imageUrl === "string" ? payload.offer.imageUrl : null, data.url);
        }
      } catch {}
    }
    if (!image) {
      try {
        image = (await fetchOpenGraph(data.url)).image ?? null;
      } catch {
        return null;
      }
    }
    if (!image) return null;
    return await ctx.runMutation(internal.productImages.applyMissing, {
      cartItemId, productId: data.productId, offerId: data.offerId, variantId: data.variantId, imageUrl: image, sourceUrl: data.url,
    });
  },
});
