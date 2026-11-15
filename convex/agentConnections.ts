import { v } from "convex/values";
import { action, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requireShopper } from "./lib/auth";
import { hashToken } from "./lib/tokens";

/**
 * A signed-in shopper mints a connection token in the app and pastes it into
 * their agent (Muse / ChatGPT). The MCP layer hashes the bearer token with
 * hashToken() and calls internal.agentConnections.resolve to get a shopperId.
 * The raw token is returned once and never stored.
 */
export const create = action({
  returns: v.object({ connectionId: v.id("agentConnections"), token: v.string() }),
  args: { label: v.string() },
  handler: async (ctx, { label }): Promise<{ connectionId: Id<"agentConnections">; token: string }> => {
    const shopperId = await requireShopper(ctx);
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const token = "cart_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const connectionId: Id<"agentConnections"> = await ctx.runMutation(internal.agentConnections.insert, {
      shopperId,
      tokenHash: await hashToken(token),
      label,
    });
    return { connectionId, token };
  },
});

export const insert = internalMutation({
  args: { shopperId: v.id("users"), tokenHash: v.string(), label: v.string() },
  handler: async (ctx, args) => await ctx.db.insert("agentConnections", { ...args, createdAt: Date.now() }),
});

export const list = query({
  returns: v.array(
    v.object({ connectionId: v.id("agentConnections"), label: v.string(), createdAt: v.number() }),
  ),
  args: {},
  handler: async (ctx) => {
    const shopperId = await requireShopper(ctx);
    const rows = await ctx.db
      .query("agentConnections")
      .withIndex("by_shopperId", (q) => q.eq("shopperId", shopperId))
      .take(200);
    return rows
      .filter((r) => !r.revokedAt)
      .map((r) => ({ connectionId: r._id, label: r.label, createdAt: r.createdAt }));
  },
});

export const revoke = mutation({
  returns: v.null(),
  args: { connectionId: v.id("agentConnections") },
  handler: async (ctx, { connectionId }) => {
    const shopperId = await requireShopper(ctx);
    const row = await ctx.db.get("agentConnections", connectionId);
    if (row && row.shopperId === shopperId) await ctx.db.patch("agentConnections", connectionId, { revokedAt: Date.now() });
    return null;
  },
});

export const resolve = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const row = await ctx.db
      .query("agentConnections")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!row || row.revokedAt) return null;
    return { shopperId: row.shopperId, connectionId: row._id };
  },
});
