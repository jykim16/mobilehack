import { defineTable } from "convex/server";
import { v } from "convex/values";

export const mcpTables = {
  mcpOAuthClients: defineTable({
    clientId: v.string(),
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_clientId", ["clientId"]),

  mcpAuthCodes: defineTable({
    codeHash: v.string(),
    clientId: v.string(),
    shopperId: v.id("users"),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    resource: v.optional(v.string()),
    scope: v.string(),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index("by_codeHash", ["codeHash"]),

  mcpPairingCodes: defineTable({
    code: v.string(),
    shopperId: v.id("users"),
    expiresAt: v.number(),
    used: v.boolean(),
  }).index("by_code", ["code"]),

  mcpTokens: defineTable({
    /** Absent on a grant row, which holds no secret of its own. */
    tokenHash: v.optional(v.string()),
    kind: v.union(v.literal("access"), v.literal("refresh"), v.literal("connection")),
    shopperId: v.id("users"),
    clientId: v.optional(v.string()),
    /** For access/refresh rows: the connection row that granted them, so one revoke kills the whole grant. */
    grantId: v.optional(v.id("mcpTokens")),
    scope: v.string(),
    label: v.optional(v.string()),
    createdAt: v.number(),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    // Legacy field on tokens minted before grant ids were dropped; kept so the
    // existing documents validate.
    grantId: v.optional(v.string()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_shopperId", ["shopperId"])
    .index("by_grantId", ["grantId"]),

  mcpDemoShoppers: defineTable({ login: v.string(), shopperId: v.id("users") }).index("by_login", ["login"]),
};
