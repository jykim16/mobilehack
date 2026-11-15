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
    clientLabel: v.optional(v.string()),
    scope: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const grantId = await ctx.db.insert("mcpTokens", {
      shopperId: args.shopperId,
      clientId: args.clientId,
      kind: "connection",
      scope: args.scope,
      label: args.clientLabel ?? "App connector",
      createdAt: now,
    });
    const base = { shopperId: args.shopperId, clientId: args.clientId, grantId, scope: args.scope, createdAt: now };
    await ctx.db.insert("mcpTokens", {
      ...base,
      kind: "access",
      tokenHash: await hashToken(args.accessToken),
      expiresAt: now + ACCESS_TOKEN_TTL_MS,
    });
    await ctx.db.insert("mcpTokens", { ...base, kind: "refresh", tokenHash: await hashToken(args.refreshToken) });
    return grantId;
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
    if (old.grantId) {
      const grant = await ctx.db.get("mcpTokens", old.grantId);
      if (!grant || grant.revokedAt) return null;
    }
    await ctx.db.patch("mcpTokens", old._id, { revokedAt: now });
    const base = {
      shopperId: old.shopperId,
      clientId: old.clientId,
      grantId: old.grantId,
      scope: old.scope,
      createdAt: now,
    };
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
    if (token.grantId) {
      const grant = await ctx.db.get("mcpTokens", token.grantId);
      if (!grant || grant.revokedAt) return null;
    }
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
      .take(200);
    return rows
      .filter((r) => r.kind === "connection" && !r.revokedAt)
      .map((r) => ({ id: r._id, label: r.label ?? "Agent", createdAt: r.createdAt }));
  },
});

/** Revoking a connection kills the grant row and every access/refresh token it issued. */
export const revokeConnection = internalMutation({
  args: { shopperId: v.id("users"), connectionId: v.id("mcpTokens") },
  handler: async (ctx, { shopperId, connectionId }) => {
    const now = Date.now();
    const grant = await ctx.db.get("mcpTokens", connectionId);
    if (!grant || grant.shopperId !== shopperId) return false;
    await ctx.db.patch("mcpTokens", connectionId, { revokedAt: now });
    // The grant check above makes any tail beyond these pages harmless, but sweep generously.
    for (let page = 0; page < 5; page++) {
      const issued = await ctx.db
        .query("mcpTokens")
        .withIndex("by_grantId", (q) => q.eq("grantId", connectionId))
        .take(200);
      let patched = 0;
      for (const row of issued) {
        if (row.revokedAt) continue;
        await ctx.db.patch("mcpTokens", row._id, { revokedAt: now });
        patched++;
      }
      if (patched === 0) break;
    }
    return true;
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
    if (row.connectionId) {
      const connection = await ctx.db.get("mcpTokens", row.connectionId);
      if (!connection || connection.revokedAt) return null;
    }
    await ctx.db.patch("mcpPairingCodes", row._id, { used: true });
    return row.shopperId;
  },
});

/** What a pasted agent credential refers to. Distinguishes a revoked token from an unknown one. */
export const resolveConnectionToken = internalQuery({
  args: { tokenHash: v.string() },
  handler: async (ctx, { tokenHash }) => {
    const token = await ctx.db
      .query("mcpTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    if (!token || token.kind !== "connection") return { status: "unknown" as const };
    if (token.revokedAt) return { status: "revoked" as const };
    return { status: "ok" as const, shopperId: token.shopperId };
  },
});

/** Hand every live token owned by one shopper to another (demo bridge). */
export const repointShopper = internalMutation({
  args: { from: v.id("users"), to: v.id("users") },
  handler: async (ctx, { from, to }) => {
    const rows = await ctx.db
      .query("mcpTokens")
      .withIndex("by_shopperId", (q) => q.eq("shopperId", from))
      .take(100);
    for (const row of rows) await ctx.db.patch("mcpTokens", row._id, { shopperId: to });
    return rows.length;
  },
});

/** What agents actually did: registered clients, authorization attempts and live connections. */
export const diagnostics = internalQuery({
  args: {},
  handler: async (ctx) => {
    const clients = await ctx.db.query("mcpOAuthClients").order("desc").take(10);
    const codes = await ctx.db.query("mcpAuthCodes").order("desc").take(10);
    const tokens = await ctx.db.query("mcpTokens").order("desc").take(15);
    return {
      clients: clients.map((c) => ({ clientId: c.clientId, clientName: c.clientName, redirectUris: c.redirectUris, at: c.createdAt })),
      codes: codes.map((c) => ({ clientId: c.clientId, redirectUri: c.redirectUri, used: c.used, at: c._creationTime })),
      tokens: tokens.map((t) => ({ kind: t.kind, label: t.label, clientId: t.clientId, at: t.createdAt })),
    };
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
