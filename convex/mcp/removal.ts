import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { loadOwnedItem, removeItemFor } from "../model/cart";

/**
 * Remove a cart item on an agent's behalf. Same rules the app enforces: another
 * shopper's item is NOT_FOUND, a pending request is expired with the item, and an
 * approved or ordered request refuses because the shopper is mid-checkout.
 */

const MID_CHECKOUT = ["approved", "ordered"] as const;

export const removeItem = internalMutation({
  args: { shopperId: v.id("users"), itemId: v.id("cartItems") },
  handler: async (ctx, { shopperId, itemId }) => {
    const item = await loadOwnedItem(ctx, shopperId, itemId);
    for (const status of MID_CHECKOUT) {
      const blocking = await ctx.db
        .query("purchaseRequests")
        .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", status))
        .take(50);
      if (blocking.some((request) => request.cartItemId === itemId)) {
        throw new ConvexError({
          code: "INVALID_STATE",
          message: "This item is mid-checkout: the shopper has to approve or cancel the purchase in the Cart app first.",
        });
      }
    }
    const product = item.productId ? await ctx.db.get("products", item.productId) : null;
    await removeItemFor(ctx, shopperId, itemId);
    return { itemId, title: product?.title ?? item.url };
  },
});

export type RemovedItem = { itemId: Id<"cartItems">; title: string };
