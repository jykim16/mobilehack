import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction, internalMutation } from "./_generated/server";
import { resolveImageUrl, sameVariant } from "./lib/firecrawlExtract";
import { fetchOpenGraph } from "./lib/opengraph";
import { canonicalKeyForUrl } from "./lib/urls";

export const applyMissing = internalMutation({
  args: { cartItemId: v.id("cartItems"), imageUrl: v.string(), sourceUrl: v.string() },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { cartItemId, imageUrl, sourceUrl }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item?.productId || canonicalKeyForUrl(item.url) !== canonicalKeyForUrl(sourceUrl)) return null;
    const product = await ctx.db.get("products", item.productId);
    if (!product) return null;
    if (product.imageUrl) return product.imageUrl;
    const image = resolveImageUrl(imageUrl, sourceUrl);
    if (!image) return null;
    await ctx.db.patch("products", product._id, { imageUrl: image });
    return image;
  },
});

export const refreshMissing = internalAction({
  args: { cartItemId: v.id("cartItems") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { cartItemId }): Promise<string | null> => {
    const data = await ctx.runQuery(internal.enrichment.getSectionContext, { cartItemId });
    if (!data || data.product.imageUrl) return data?.product.imageUrl ?? null;
    const cached = await ctx.runQuery(internal.cache.read, { kind: "offer", key: data.offer.canonicalKey });
    let image: string | null = null;
    if (cached?.payload) {
      try {
        const payload = JSON.parse(cached.payload);
        if (payload.variantMatches === true && sameVariant(data.offer.canonicalKey, payload.offer?.asinOrSku ?? null)) {
          image = resolveImageUrl(typeof payload.offer?.imageUrl === "string" ? payload.offer.imageUrl : null, data.item.url);
        }
      } catch {}
    }
    if (!image) {
      try {
        image = (await fetchOpenGraph(data.item.url)).image ?? null;
      } catch {
        return null;
      }
    }
    if (!image) return null;
    return await ctx.runMutation(internal.productImages.applyMissing, { cartItemId, imageUrl: image, sourceUrl: data.item.url });
  },
});
