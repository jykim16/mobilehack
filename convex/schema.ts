import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mcpTables } from "./mcp/tables";
import {
  actor,
  conditionClass,
  decision,
  enrichmentStatus,
  evidenceScope,
  highlight,
  orderStatus,
  purchaseStatus,
  quote,
  sectionName,
  sectionStatus,
  shipmentStatus,
  source,
} from "./lib/validators";

export default defineSchema({
  ...authTables,

  products: defineTable({
    title: v.string(),
    brand: v.optional(v.string()),
    category: v.string(),
    imageUrl: v.optional(v.string()),
    description: v.optional(v.string()),
    demoKey: v.optional(v.string()),
  }).index("by_demoKey", ["demoKey"]),

  variants: defineTable({
    productId: v.id("products"),
    label: v.string(),
    sku: v.optional(v.string()),
  }).index("by_productId", ["productId"]),

  offers: defineTable({
    productId: v.id("products"),
    variantId: v.id("variants"),
    retailer: v.string(),
    retailerName: v.string(),
    seller: v.string(),
    url: v.string(),
    canonicalKey: v.string(),
    priceCents: v.number(),
    listPriceCents: v.optional(v.number()),
    shippingCents: v.number(),
    currency: v.string(),
    deliveryEstimate: v.string(),
    returnSummary: v.string(),
    rating: v.optional(v.object({ average: v.number(), count: v.number() })),
    condition: v.optional(v.string()),
    conditionClass: v.optional(conditionClass),
    /** Non-new offers seen at this URL: stored and labeled, never presented as the item. */
    alternates: v.optional(
      v.array(
        v.object({
          conditionClass,
          condition: v.union(v.string(), v.null()),
          seller: v.union(v.string(), v.null()),
          priceCents: v.union(v.number(), v.null()),
          sourceUrl: v.string(),
          observedAt: v.number(),
        }),
      ),
    ),
    provenance: v.optional(
      v.object({
        method: v.union(v.literal("firecrawl"), v.literal("opengraph"), v.literal("seed")),
        sourceUrl: v.string(),
        observedAt: v.number(),
        supportingText: v.union(v.string(), v.null()),
        verifiedKey: v.union(v.string(), v.null()),
        note: v.union(v.string(), v.null()),
      }),
    ),
    inStock: v.boolean(),
    simulated: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_canonicalKey", ["canonicalKey"])
    .index("by_productId", ["productId"]),

  priceObservations: defineTable({
    offerId: v.id("offers"),
    priceCents: v.number(),
    shippingCents: v.number(),
    observedAt: v.number(),
    source: v.string(),
    simulated: v.boolean(),
  }).index("by_offerId_and_observedAt", ["offerId", "observedAt"]),

  cartItems: defineTable({
    shopperId: v.id("users"),
    url: v.string(),
    productId: v.optional(v.id("products")),
    variantId: v.optional(v.id("variants")),
    offerId: v.optional(v.id("offers")),
    quantity: v.number(),
    reason: v.optional(v.string()),
    addedBy: actor,
    status: v.union(v.literal("active"), v.literal("purchased"), v.literal("removed")),
    enrichmentStatus,
    decision: v.optional(decision),
    idempotencyKey: v.string(),
    addedAt: v.number(),
  })
    .index("by_shopperId_and_status", ["shopperId", "status"])
    .index("by_shopperId_and_idempotencyKey", ["shopperId", "idempotencyKey"])
    .index("by_offerId_and_status", ["offerId", "status"]),

  evidence: defineTable({
    shopperId: v.id("users"),
    cartItemId: v.id("cartItems"),
    section: sectionName,
    status: sectionStatus,
    attempts: v.number(),
    scope: evidenceScope,
    summary: v.optional(v.string()),
    highlights: v.array(highlight),
    sources: v.array(source),
    items: v.optional(
      v.array(
        v.object({
          author: v.union(v.string(), v.null()),
          text: v.string(),
          url: v.string(),
          createdAt: v.union(v.number(), v.null()),
          score: v.union(v.number(), v.null()),
          community: v.union(v.string(), v.null()),
        }),
      ),
    ),
    checkedAt: v.optional(v.number()),
    history: v.optional(
      v.object({
        mode: v.union(
          v.literal("live"),
          v.literal("sampled"),
          v.literal("fallback"),
          v.literal("observations"),
        ),
        seriesLabel: v.union(v.string(), v.null()),
        currency: v.union(v.string(), v.null()),
        sourceUrl: v.union(v.string(), v.null()),
        sampled: v.boolean(),
        note: v.union(v.string(), v.null()),
        points: v.array(v.object({ at: v.union(v.number(), v.null()), priceCents: v.number() })),
      }),
    ),
    details: v.optional(
      v.object({
        returnWindowDays: v.union(v.number(), v.null()),
        freeReturns: v.union(v.boolean(), v.null()),
        openedItemRestrictions: v.union(v.string(), v.null()),
        eligibilityScope: v.union(
          v.literal("offer"),
          v.literal("storewide"),
          v.literal("unconfirmed"),
          v.null(),
        ),
        status: v.union(v.literal("confirmed"), v.literal("unconfirmed")),
        supportingText: v.union(v.string(), v.null()),
        sourceUrl: v.union(v.string(), v.null()),
      }),
    ),
    simulated: v.boolean(),
    error: v.optional(v.string()),
  }).index("by_cartItemId_and_section", ["cartItemId", "section"]),

  purchaseRequests: defineTable({
    shopperId: v.id("users"),
    cartItemId: v.id("cartItems"),
    offerId: v.id("offers"),
    quantity: v.number(),
    reason: v.string(),
    requestedBy: actor,
    idempotencyKey: v.string(),
    status: purchaseStatus,
    quoteVersion: v.number(),
    quote: v.optional(quote),
    expiresAt: v.number(),
    decidedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_shopperId_and_status", ["shopperId", "status"])
    .index("by_shopperId_and_idempotencyKey", ["shopperId", "idempotencyKey"]),

  orders: defineTable({
    shopperId: v.id("users"),
    purchaseRequestId: v.id("purchaseRequests"),
    cartItemId: v.id("cartItems"),
    orderRef: v.string(),
    retailer: v.string(),
    retailerOrderId: v.optional(v.string()),
    status: orderStatus,
    quoteVersion: v.number(),
    quote: quote,
    submitAttempts: v.number(),
    placedAt: v.optional(v.number()),
    simulated: v.boolean(),
    error: v.optional(v.string()),
  })
    .index("by_purchaseRequestId", ["purchaseRequestId"])
    .index("by_shopperId", ["shopperId"])
    .index("by_orderRef", ["orderRef"])
    .index("by_retailerOrderId", ["retailerOrderId"]),

  shipments: defineTable({
    shopperId: v.id("users"),
    orderId: v.id("orders"),
    status: shipmentStatus,
    carrier: v.optional(v.string()),
    trackingNumber: v.optional(v.string()),
    trackingUrl: v.optional(v.string()),
    eta: v.optional(v.string()),
    events: v.optional(
      v.array(
        v.object({
          status: v.string(),
          description: v.string(),
          location: v.union(v.string(), v.null()),
          occurredAt: v.number(),
        }),
      ),
    ),
    updatedAt: v.number(),
    simulated: v.boolean(),
  }).index("by_orderId", ["orderId"]),

  priceComparisons: defineTable({
    shopperId: v.id("users"),
    cartItemId: v.id("cartItems"),
    subjectUrl: v.string(),
    query: v.string(),
    exaRunId: v.optional(v.string()),
    status: v.union(
      v.literal("running"),
      v.literal("verifying"),
      v.literal("completed"),
      v.literal("empty"),
      v.literal("failed"),
    ),
    attempts: v.number(),
    checkedAt: v.optional(v.number()),
    note: v.optional(v.string()),
    candidates: v.array(
      v.object({
        retailer: v.string(),
        seller: v.union(v.string(), v.null()),
        productUrl: v.string(),
        matchedIdentifier: v.union(v.string(), v.null()),
        condition: v.union(v.string(), v.null()),
        priceCents: v.union(v.number(), v.null()),
        currency: v.union(v.string(), v.null()),
        availability: v.union(v.string(), v.null()),
        supportingSource: v.union(v.string(), v.null()),
      }),
    ),
    offers: v.array(
      v.object({
        retailer: v.string(),
        seller: v.union(v.string(), v.null()),
        productUrl: v.string(),
        matchedIdentifier: v.union(v.string(), v.null()),
        condition: v.union(v.string(), v.null()),
        priceCents: v.union(v.number(), v.null()),
        currency: v.union(v.string(), v.null()),
        availability: v.union(v.string(), v.null()),
        supportingSource: v.union(v.string(), v.null()),
        shippingCents: v.union(v.number(), v.null()),
        verifiedAt: v.union(v.number(), v.null()),
        rejectedReason: v.union(v.string(), v.null()),
      }),
    ),
  })
    .index("by_cartItemId", ["cartItemId"])
    .index("by_exaRunId", ["exaRunId"]),

  simulatedRetailerOrders: defineTable({
    orderRef: v.string(),
    retailer: v.string(),
    retailerOrderId: v.string(),
    trackingNumber: v.string(),
    placedAt: v.number(),
  }).index("by_orderRef", ["orderRef"]),

  ...mcpTables,
});
