import { mutation } from "./_generated/server";
import { v } from "convex/values";

export const cast = mutation({
  args: {
    itemId: v.id("items"),
    voterKey: v.string(),
    voterName: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
    comment: v.optional(v.string()),
  },
  handler: async (ctx, { itemId, voterKey, voterName, value, comment }) => {
    const item = await ctx.db.get(itemId);
    if (!item) throw new Error("Item not found");
    const existing = await ctx.db
      .query("votes")
      .withIndex("by_item_voter", (q) => q.eq("itemId", itemId).eq("voterKey", voterKey))
      .unique();
    const fields = { value, voterName: voterName.trim() || "Friend", comment: comment?.trim() || undefined };
    if (existing) {
      await ctx.db.patch(existing._id, fields);
      return existing._id;
    }
    return await ctx.db.insert("votes", { itemId, cartId: item.cartId, voterKey, ...fields });
  },
});
