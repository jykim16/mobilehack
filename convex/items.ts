import { action, internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { alternative } from "./schema";
import { Id } from "./_generated/dataModel";
import { cartForDevice, hydrateItem } from "./carts";
import { merchantDomain } from "./lib/merchants";
import { scrapeProduct } from "./lib/scrape";
import { normalizeCoolingOff } from "./lib/confidence";

export const get = query({
  args: { itemId: v.id("items"), now: v.number() },
  handler: async (ctx, { itemId, now }) => {
    const item = await ctx.db.get(itemId);
    if (!item) return null;
    const cart = await ctx.db.get(item.cartId);
    return { ...(await hydrateItem(ctx, item, now)), shareCode: cart?.shareCode };
  },
});

export const preview = action({
  args: { url: v.string() },
  handler: async (_ctx, { url }) => scrapeProduct(url),
});

export const add = mutation({
  args: {
    deviceId: v.string(),
    title: v.string(),
    url: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    price: v.optional(v.number()),
    wasPrice: v.optional(v.number()),
    coolingOffHours: v.optional(v.number()),
    note: v.optional(v.string()),
  },
  handler: async (ctx, { deviceId, note, ...fields }) => {
    const found = await cartForDevice(ctx, deviceId);
    if (!found) throw new Error("No cart for this device");
    return await ctx.db.insert("items", {
      ...fields,
      coolingOffHours: normalizeCoolingOff(fields.coolingOffHours),
      cartId: found.cart._id,
      merchantDomain: merchantDomain(fields.url),
      addedAt: Date.now(),
      addedByKind: "user",
      addedByName: found.user.name,
      rationale: note,
      status: "considering",
    });
  },
});

export const addFromAgent = internalMutation({
  args: {
    agentId: v.id("agents"),
    title: v.string(),
    url: v.string(),
    imageUrl: v.optional(v.string()),
    price: v.optional(v.number()),
    wasPrice: v.optional(v.number()),
    rationale: v.string(),
    alternatives: v.optional(v.array(alternative)),
    coolingOffHours: v.optional(v.number()),
    merchantDomain: v.optional(v.string()),
  },
  handler: async (ctx, { agentId, ...fields }) => {
    const agent = await ctx.db.get(agentId);
    if (!agent) throw new Error("Unknown agent");
    await ctx.db.patch(agentId, { lastUsedAt: Date.now() });
    return await ctx.db.insert("items", {
      ...fields,
      coolingOffHours: normalizeCoolingOff(fields.coolingOffHours),
      merchantDomain: fields.merchantDomain ?? merchantDomain(fields.url),
      cartId: agent.cartId,
      agentId,
      addedAt: Date.now(),
      addedByKind: "agent",
      addedByName: agent.name,
      status: "considering",
    });
  },
});

async function ownedItem(ctx: Parameters<typeof cartForDevice>[0], deviceId: string, itemId: Id<"items">) {
  const found = await cartForDevice(ctx, deviceId);
  const item = await ctx.db.get(itemId);
  if (!found || !item || item.cartId !== found.cart._id) throw new Error("Not your item");
  return item;
}

export const setCoolingOff = mutation({
  args: { deviceId: v.string(), itemId: v.id("items"), hours: v.optional(v.number()) },
  handler: async (ctx, { deviceId, itemId, hours }) => {
    await ownedItem(ctx, deviceId, itemId);
    await ctx.db.patch(itemId, { coolingOffHours: normalizeCoolingOff(hours) });
  },
});

export const markPurchased = mutation({
  args: { deviceId: v.string(), itemId: v.id("items") },
  handler: async (ctx, { deviceId, itemId }) => {
    await ownedItem(ctx, deviceId, itemId);
    await ctx.db.patch(itemId, { status: "purchased" });
  },
});

export const remove = mutation({
  args: { deviceId: v.string(), itemId: v.id("items") },
  handler: async (ctx, { deviceId, itemId }) => {
    await ownedItem(ctx, deviceId, itemId);
    const votes = await ctx.db
      .query("votes")
      .withIndex("by_item", (q) => q.eq("itemId", itemId))
      .collect();
    for (const vote of votes) await ctx.db.delete(vote._id);
    await ctx.db.delete(itemId);
  },
});
