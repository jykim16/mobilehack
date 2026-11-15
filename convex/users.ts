import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { ensureMerchants, seedDemoCart } from "./lib/demo";

function shareCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

export const ensure = mutation({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    await ensureMerchants(ctx);
    const existing = await ctx.db
      .query("users")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (existing) return existing._id;
    const userId = await ctx.db.insert("users", { deviceId, name: "You", isPro: false });
    const cartId = await ctx.db.insert("carts", { ownerId: userId, name: "My Cart", shareCode: shareCode() });
    await seedDemoCart(ctx, cartId, userId);
    return userId;
  },
});

export const me = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    return await ctx.db
      .query("users")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
  },
});

export const setName = mutation({
  args: { deviceId: v.string(), name: v.string() },
  handler: async (ctx, { deviceId, name }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (!user) throw new Error("Unknown user");
    await ctx.db.patch(user._id, { name: name.trim() || "You" });
  },
});

export const setPro = mutation({
  args: { deviceId: v.string(), isPro: v.boolean() },
  handler: async (ctx, { deviceId, isPro }) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
      .unique();
    if (!user) throw new Error("Unknown user");
    await ctx.db.patch(user._id, { isPro });
  },
});
