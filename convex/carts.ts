import { query, QueryCtx } from "./_generated/server";
import { v } from "convex/values";
import { Doc, Id } from "./_generated/dataModel";
import { computeConfidence } from "./lib/confidence";

export async function cartForDevice(ctx: QueryCtx, deviceId: string) {
  const user = await ctx.db
    .query("users")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .unique();
  if (!user) return null;
  const cart = await ctx.db
    .query("carts")
    .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
    .first();
  return cart ? { user, cart } : null;
}

export async function hydrateItem(ctx: QueryCtx, item: Doc<"items">, now: number) {
  const votes = await ctx.db
    .query("votes")
    .withIndex("by_item", (q) => q.eq("itemId", item._id))
    .collect();
  const merchant = item.merchantDomain
    ? await ctx.db
        .query("merchants")
        .withIndex("by_domain", (q) => q.eq("domain", item.merchantDomain!))
        .unique()
    : null;
  return { ...item, votes, merchant, confidence: computeConfidence(item, votes, merchant, now) };
}

async function cartView(ctx: QueryCtx, cart: Doc<"carts">, now: number) {
  const items = await ctx.db
    .query("items")
    .withIndex("by_cart", (q) => q.eq("cartId", cart._id as Id<"carts">))
    .order("desc")
    .collect();
  const hydrated = await Promise.all(items.map((i) => hydrateItem(ctx, i, now)));
  const active = hydrated.filter((i) => i.status === "considering");
  const total = active.reduce((s, i) => s + (i.price ?? 0), 0);
  const avg = active.length ? Math.round(active.reduce((s, i) => s + i.confidence.score, 0) / active.length) : 0;
  return {
    cart,
    items: hydrated,
    summary: {
      count: active.length,
      total,
      averageConfidence: avg,
      ready: active.filter((i) => i.confidence.ready).length,
      fromAgents: active.filter((i) => i.addedByKind === "agent").length,
      votes: active.reduce((s, i) => s + i.votes.length, 0),
    },
  };
}

export const mine = query({
  args: { deviceId: v.string(), now: v.number() },
  handler: async (ctx, { deviceId, now }) => {
    const found = await cartForDevice(ctx, deviceId);
    if (!found) return null;
    return { user: found.user, ...(await cartView(ctx, found.cart, now)) };
  },
});

export const byShareCode = query({
  args: { code: v.string(), now: v.number() },
  handler: async (ctx, { code, now }) => {
    const cart = await ctx.db
      .query("carts")
      .withIndex("by_share_code", (q) => q.eq("shareCode", code.trim().toUpperCase()))
      .unique();
    if (!cart) return null;
    const owner = await ctx.db.get(cart.ownerId);
    const ownerName = owner && owner.name !== "You" ? owner.name : "Your friend";
    return { ownerName, ...(await cartView(ctx, cart, now)) };
  },
});
