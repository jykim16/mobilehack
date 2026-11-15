import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { hashToken } from "../lib/tokens";

export const ACCESS_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export const registerClient = internalMutation({
  args: { clientId: v.string(), clientName: v.optional(v.string()), redirectUris: v.array(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("mcpOAuthClients", { ...args, createdAt: Date.now() });
    return null;
  },
});

export const getClient = internalQuery({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const client = await ctx.db
      .query("mcpOAuthClients")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    return client ? { clientId: client.clientId, clientName: client.clientName ?? null, redirectUris: client.redirectUris } : null;
  },
});

export const createAuthCode = internalMutation({
  args: {
    codeHash: v.string(),
    clientId: v.string(),
    shopperId: v.id("users"),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
    scope: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("mcpAuthCodes", { ...args, expiresAt: Date.now() + CODE_TTL_MS, used: false });
    return null;
  },
});

export const consumeAuthCode = internalMutation({
  args: { codeHash: v.string() },
  handler: async (ctx, { codeHash }) => {
    const code = await ctx.db
      .query("mcpAuthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    if (!code || code.used || code.expiresAt < Date.now()) return null;
    await ctx.db.patch("mcpAuthCodes", code._id, { used: true });
    return {
      clientId: code.clientId,
      shopperId: code.shopperId,
      redirectUri: code.redirectUri,
      codeChallenge: code.codeChallenge,
      scope: code.scope,
    };
  },
});

export const issueTokens = internalMutation({
  args: {
    shopperId: v.id("users"),
    clientId: v.string(),
    scope: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const base = { shopperId: args.shopperId, clientId: args.clientId, scope: args.scope, createdAt: now };
    await ctx.db.insert("mcpTokens", {
      ...base,
      kind: "access",
      tokenHash: await hashToken(args.accessToken),
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    await ctx.db.insert("mcpTokens", { ...base, kind: "refresh", tokenHash: await hashToken(args.refreshToken) });
    return null;
  },
});

export const rotateRefreshToken = internalMutation({
  args: { refreshToken: v.string(), clientId: v.string(), accessToken: v.string(), newRefreshToken: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const refreshHash = await hashToken(args.refreshToken);
    const old = await ctx.db
      .query("mcpTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", refreshHash))
      .unique();
    if (!old || old.kind !== "refresh" || old.revokedAt || old.clientId !== args.clientId) return null;
    await ctx.db.patch("mcpTokens", old._id, { revokedAt: now });
    const base = { shopperId: old.shopperId, clientId: old.clientId, scope: old.scope, createdAt: now };
    await ctx.db.insert("mcpTokens", {
      ...base,
      kind: "access",
      tokenHash: await hashToken(args.accessToken),
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    await ctx.db.insert("mcpTokens", { ...base, kind: "refresh", tokenHash: await hashToken(args.newRefreshToken) });
    return { scope: old.scope };
  },
});

export const resolveAccessToken = internalQuery({
  args: { tokenHash: v.string(), now: v.number() },
  handler: async (ctx, { tokenHash, now }) => {
    const token = await ctx.db
      .query("mcpTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!token || token.revokedAt || token.kind === "refresh") return null;
    if (token.expiresAt !== undefined && token.expiresAt < now) return null;
    return { shopperId: token.shopperId };
  },
});

export const insertConnectionToken = internalMutation({
  args: { shopperId: v.id("users"), tokenHash: v.string(), label: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.insert("mcpTokens", {
      shopperId: args.shopperId,
      tokenHash: args.tokenHash,
      label: args.label,
      kind: "connection",
      scope: "cart",
      createdAt: Date.now(),
    });
  },
});

export const listConnectionTokens = internalQuery({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => {
    const rows = await ctx.db
      .query("mcpTokens")
      .withIndex("by_shopperId", (q) => q.eq("shopperId", shopperId))
      .take(100);
    return rows.filter((r) => r.kind === "connection").map((r) => ({ id: r._id, label: r.label ?? "Agent", createdAt: r.createdAt }));
  },
});

export const revokeToken = internalMutation({
  args: { shopperId: v.id("users"), tokenId: v.id("mcpTokens") },
  handler: async (ctx, { shopperId, tokenId }) => {
    const row = await ctx.db.get("mcpTokens", tokenId);
    if (row && row.shopperId === shopperId) await ctx.db.patch("mcpTokens", tokenId, { revokedAt: Date.now() });
    return null;
  },
});

export const consumePairingCode = internalMutation({
  args: { code: v.string() },
  handler: async (ctx, { code }) => {
    const normalized = code.replace(/[\s-]/g, "").toUpperCase();
    const row = await ctx.db
      .query("mcpPairingCodes")
      .withIndex("by_code", (q) => q.eq("code", normalized))
      .unique();
    if (!row || row.used || row.expiresAt < Date.now()) return null;
    await ctx.db.patch("mcpPairingCodes", row._id, { used: true });
    return row.shopperId;
  },
});

export const demoShopper = internalQuery({
  args: { login: v.string() },
  handler: async (ctx, { login }) => {
    const row = await ctx.db
      .query("mcpDemoShoppers")
      .withIndex("by_login", (q) => q.eq("login", login))
      .unique();
    return row?.shopperId ?? null;
  },
});
