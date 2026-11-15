import { ConvexError, v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, mutation, query } from "../_generated/server";
import { requireShopper } from "../lib/auth";
import { hashToken } from "../lib/tokens";

/**
 * How an agent connection becomes a Cart shopper. The app mints a short pairing
 * code (OAuth sign-in page) or a long-lived connection token (bearer auth for
 * agents that only accept a key). Both live in the mcp* tables.
 */

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const createPairingCode = mutation({
  args: {},
  handler: async (ctx): Promise<{ code: string; expiresAt: number }> => {
    const shopperId = await requireShopper(ctx);
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const code = Array.from(bytes, (b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join("");
    const expiresAt = Date.now() + PAIRING_CODE_TTL_MS;
    await ctx.db.insert("mcpPairingCodes", { code, shopperId, expiresAt, used: false });
    return { code, expiresAt };
  },
});

/** The Muse path: the app mints a bearer token for its own (anonymous) shopper and shows it once. */
export const create = mutation({
  args: { label: v.optional(v.string()) },
  handler: async (ctx, { label }): Promise<{ token: string }> => {
    const shopperId = await requireShopper(ctx);
    const token = "cart_ct_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await ctx.db.insert("mcpTokens", {
      shopperId,
      tokenHash: await hashToken(token),
      kind: "connection",
      scope: "cart",
      label: label ?? "Agent",
      createdAt: Date.now(),
    });
    return { token };
  },
});

export const listConnections = query({
  args: {},
  handler: async (ctx): Promise<{ id: Id<"mcpTokens">; label: string; createdAt: number }[]> => {
    const shopperId = await requireShopper(ctx);
    return await ctx.runQuery(internal.mcp.store.listConnectionTokens, { shopperId });
  },
});

export const revokeConnection = mutation({
  args: { tokenId: v.id("mcpTokens") },
  handler: async (ctx, { tokenId }) => {
    const shopperId = await requireShopper(ctx);
    const revoked = await ctx.runMutation(internal.mcp.store.revokeConnection, { shopperId, connectionId: tokenId });
    if (!revoked) throw new ConvexError({ code: "NOT_FOUND", message: "Connection not found." });
    return null;
  },
});

export const rememberDemoShopper = internalMutation({
  args: { login: v.string(), shopperId: v.id("users") },
  handler: async (ctx, args) => {
    await ctx.db.insert("mcpDemoShoppers", args);
    return null;
  },
});

export const mintDemoConnection = internalMutation({
  args: { login: v.string() },
  handler: async (ctx, { login }): Promise<{ token: string; shopperId: Id<"users">; connectionId: Id<"mcpTokens"> }> => {
    const existing = await ctx.db
      .query("mcpDemoShoppers")
      .withIndex("by_login", (q) => q.eq("login", login))
      .unique();
    const shopperId = existing?.shopperId ?? (await ctx.db.insert("users", { name: `Demo shopper (${login})`, isAnonymous: true }));
    if (!existing) await ctx.db.insert("mcpDemoShoppers", { login, shopperId });
    const token = "cart_ct_" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    const connectionId = await ctx.db.insert("mcpTokens", {
      shopperId,
      tokenHash: await hashToken(token),
      kind: "connection",
      scope: "cart",
      label: `CLI demo (${login})`,
      createdAt: Date.now(),
    });
    return { token, shopperId, connectionId };
  },
});
