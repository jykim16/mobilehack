import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const alternative = v.object({
  title: v.string(),
  price: v.optional(v.number()),
  url: v.optional(v.string()),
  reason: v.optional(v.string()),
});

export default defineSchema({
  users: defineTable({
    deviceId: v.string(),
    name: v.string(),
    isPro: v.boolean(),
  }).index("by_device", ["deviceId"]),

  carts: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
    shareCode: v.string(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_share_code", ["shareCode"]),

  items: defineTable({
    cartId: v.id("carts"),
    title: v.string(),
    url: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    merchantDomain: v.optional(v.string()),
    price: v.optional(v.number()),
    wasPrice: v.optional(v.number()),
    addedAt: v.number(),
    addedByKind: v.union(v.literal("user"), v.literal("agent")),
    addedByName: v.string(),
    agentId: v.optional(v.id("agents")),
    rationale: v.optional(v.string()),
    alternatives: v.optional(v.array(alternative)),
    coolingOffHours: v.optional(v.number()),
    status: v.union(v.literal("considering"), v.literal("purchased")),
  }).index("by_cart", ["cartId"]),

  votes: defineTable({
    itemId: v.id("items"),
    cartId: v.id("carts"),
    voterKey: v.string(),
    voterName: v.string(),
    value: v.union(v.literal(1), v.literal(-1)),
    comment: v.optional(v.string()),
  })
    .index("by_item", ["itemId"])
    .index("by_item_voter", ["itemId", "voterKey"])
    .index("by_cart", ["cartId"]),

  merchants: defineTable({
    domain: v.string(),
    name: v.string(),
    returnDays: v.number(),
    freeReturns: v.boolean(),
    summary: v.string(),
  }).index("by_domain", ["domain"]),

  agents: defineTable({
    userId: v.id("users"),
    cartId: v.id("carts"),
    name: v.string(),
    keyHash: v.string(),
    keyPrefix: v.string(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_user", ["userId"])
    .index("by_key_hash", ["keyHash"]),
});
