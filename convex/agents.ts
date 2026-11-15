import { internalQuery, mutation, query } from "./_generated/server";
import { v } from "convex/values";
import { cartForDevice } from "./carts";

export async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const list = query({
  args: { deviceId: v.string() },
  handler: async (ctx, { deviceId }) => {
    const found = await cartForDevice(ctx, deviceId);
    if (!found) return [];
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_user", (q) => q.eq("userId", found.user._id))
      .collect();
    return agents.filter((a) => a.keyPrefix !== "demo").map(({ keyHash: _h, ...a }) => a);
  },
});

export const create = mutation({
  args: { deviceId: v.string(), name: v.string() },
  handler: async (ctx, { deviceId, name }) => {
    const found = await cartForDevice(ctx, deviceId);
    if (!found) throw new Error("No cart for this device");
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const key = "uc_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    await ctx.db.insert("agents", {
      userId: found.user._id,
      cartId: found.cart._id,
      name: name.trim() || "My Agent",
      keyHash: await sha256(key),
      keyPrefix: key.slice(0, 7),
    });
    return key;
  },
});

export const revoke = mutation({
  args: { deviceId: v.string(), agentId: v.id("agents") },
  handler: async (ctx, { deviceId, agentId }) => {
    const found = await cartForDevice(ctx, deviceId);
    const agent = await ctx.db.get(agentId);
    if (!found || !agent || agent.userId !== found.user._id) throw new Error("Not your agent");
    await ctx.db.delete(agentId);
  },
});

export const byKeyHash = internalQuery({
  args: { keyHash: v.string() },
  handler: async (ctx, { keyHash }) =>
    await ctx.db
      .query("agents")
      .withIndex("by_key_hash", (q) => q.eq("keyHash", keyHash))
      .unique(),
});
