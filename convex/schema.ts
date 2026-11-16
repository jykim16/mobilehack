import { defineSchema, defineTable } from "convex/server";
import { authTables } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { mcpTables } from "./mcp/tables";
import {
  actor,
  cardStatus,
  cardTransactionStatus,
  paymentStatus,
  revalidation,
  subaccountStatus,
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

  /**
   * One row per upstream answer, keyed by what the call depends on: a canonical
   * listing URL for an extraction, a product model for a comparison or a Reddit
   * lookup, the normalized words for a query resolution. Shared across shoppers,
   * so two adds of the same URL cost one scrape.
   */
  extractionCache: defineTable({
    kind: v.union(
      v.literal("offer"),
      v.literal("comparison"),
      v.literal("query"),
      v.literal("reddit"),
    ),
    key: v.string(),
    payload: v.optional(v.string()),
    fetchedAt: v.number(),
    source: v.string(),
    simulated: v.boolean(),
    attempts: v.number(),
    lastAttemptAt: v.optional(v.number()),
    pendingStartedAt: v.optional(v.number()),
    /** Identifies the run that owns the lock, so a slow run cannot clear or
     * overwrite what a later run wrote. */
    pendingToken: v.optional(v.string()),
    /** Set when a forced refresh asked for a fresh read; the payload and its real
     * read time survive so a refusal can still serve it, honestly dated. */
    invalidatedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index("by_kind_and_key", ["kind", "key"]),

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
    pendingRun: v.optional(v.string()),
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
    .index("by_shopperId_and_idempotencyKey", ["shopperId", "idempotencyKey"])
    .index("by_cartItemId_and_status", ["cartItemId", "status"]),

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
    /** Money trail: the payment that funded this order and the card charge against it. */
    paymentId: v.optional(v.id("payments")),
    cardTransactionId: v.optional(v.id("cardTransactions")),
    subaccountId: v.optional(v.id("shopperSubaccounts")),
    /** The retailer was re-read immediately before the charge. */
    revalidatedAt: v.optional(v.number()),
    revalidation: v.optional(revalidation),
    refundedAt: v.optional(v.number()),
  })
    .index("by_purchaseRequestId", ["purchaseRequestId"])
    .index("by_shopperId", ["shopperId"])
    .index("by_orderRef", ["orderRef"])
    .index("by_retailerOrderId", ["retailerOrderId"]),

  /**
   * One Whop subaccount per shopper who funds a Cart purchase. Balances, the card
   * and its limits live on the subaccount; Cart never holds a platform-wide pool.
   * Only the provider's card id and its last four digits are stored.
   */
  shopperSubaccounts: defineTable({
    shopperId: v.id("users"),
    provider: v.literal("whop"),
    providerAccountId: v.string(),
    environment: v.union(v.literal("sandbox"), v.literal("production")),
    status: subaccountStatus,
    /** Production onboarding is a documented per-shopper step; the demo reuses one
     * pre-verified sandbox subaccount and records kycRequired so nobody confuses it. */
    kycRequired: v.boolean(),
    onboardingUrl: v.optional(v.string()),
    payoutsEnabled: v.optional(v.boolean()),
    cardId: v.optional(v.string()),
    cardLast4: v.optional(v.string()),
    cardStatus: cardStatus,
    cardSpendLimitCents: v.optional(v.number()),
    /** Issuer-side cap on a single charge, which is how a per-order limit is enforced. */
    cardTransactionLimitCents: v.optional(v.number()),
    cardIssuedAt: v.optional(v.number()),
    cardNote: v.optional(v.string()),
    /** Balances Cart computes from its own ledger (money in minus card spend). */
    availableBalanceCents: v.optional(v.number()),
    balanceCheckedAt: v.optional(v.number()),
    /** Balances the provider reports for the account, unmodified and separately labeled. */
    providerAvailableCents: v.optional(v.number()),
    providerPendingCents: v.optional(v.number()),
    providerCurrency: v.optional(v.string()),
    providerFetchedAt: v.optional(v.number()),
    providerSettlementDate: v.optional(v.string()),
    /** What the provider says it can do with cards on this account. */
    providerCardCount: v.optional(v.number()),
    providerOnboarding: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_shopperId", ["shopperId"])
    .index("by_providerAccountId", ["providerAccountId"]),

  /** Money in: the one-time Whop checkout for an approved quote. */
  payments: defineTable({
    shopperId: v.id("users"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    subaccountId: v.id("shopperSubaccounts"),
    providerCheckoutConfigId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    /** Set by the webhook; unique per provider payment, so a replay records once. */
    providerPaymentId: v.optional(v.string()),
    amountCents: v.number(),
    currency: v.string(),
    status: paymentStatus,
    paidAt: v.optional(v.number()),
    failureReason: v.optional(v.string()),
    refundId: v.optional(v.string()),
    refundAmountCents: v.optional(v.number()),
    refundedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_providerPaymentId", ["providerPaymentId"])
    .index("by_subaccountId", ["subaccountId"])
    .index("by_requestId", ["requestId"])
    .index("by_shopperId_and_status", ["shopperId", "status"]),

  /** Money out: the retailer charge against the subaccount's card. */
  cardTransactions: defineTable({
    shopperId: v.id("users"),
    subaccountId: v.id("shopperSubaccounts"),
    requestId: v.id("purchaseRequests"),
    quoteVersion: v.number(),
    orderId: v.optional(v.id("orders")),
    cardId: v.string(),
    amountCents: v.number(),
    currency: v.string(),
    status: cardTransactionStatus,
    providerTransactionId: v.optional(v.string()),
    /** Display only: the provider's masked card, never a PAN or a CVV. */
    maskedCard: v.optional(v.string()),
    merchantName: v.string(),
    orderReference: v.string(),
    /** A charge whose outcome never came back; it blocks retries until reconciled. */
    unknownCharge: v.boolean(),
    note: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_orderId", ["orderId"])
    .index("by_subaccountId", ["subaccountId"])
    .index("by_providerTransactionId", ["providerTransactionId"])
    .index("by_shopperId_and_status", ["shopperId", "status"]),

  /** Every webhook delivery, keyed by the provider's event id so a replay is a no-op. */
  whopWebhookEvents: defineTable({
    providerEventId: v.string(),
    type: v.string(),
    receivedAt: v.number(),
    signatureVerified: v.boolean(),
    processedAt: v.optional(v.number()),
    outcome: v.optional(v.string()),
    /** A hash of the body, not the body: no customer data is kept for debugging. */
    payloadDigest: v.string(),
  }).index("by_providerEventId", ["providerEventId"]),

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
        reportedBy: v.optional(v.union(v.literal("exa"))),
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
