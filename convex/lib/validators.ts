import { v, Infer } from "convex/values";

export const sectionName = v.union(
  v.literal("categoryGuidance"),
  v.literal("returnTerms"),
  v.literal("priceHistory"),
  v.literal("retailerReviews"),
  v.literal("reddit"),
);
export type SectionName = Infer<typeof sectionName>;
export const SECTION_NAMES: SectionName[] = [
  "categoryGuidance",
  "returnTerms",
  "priceHistory",
  "retailerReviews",
  "reddit",
];

export const sectionStatus = v.union(
  v.literal("pending"),
  v.literal("loading"),
  v.literal("running"),
  v.literal("ready"),
  v.literal("failed"),
);
export type SectionStatus = Infer<typeof sectionStatus>;

export const evidenceScope = v.union(v.literal("product"), v.literal("offer"));

export const source = v.object({
  title: v.string(),
  url: v.string(),
  publisher: v.optional(v.string()),
});

export const highlight = v.object({
  label: v.string(),
  detail: v.string(),
  tone: v.union(
    v.literal("positive"),
    v.literal("negative"),
    v.literal("neutral"),
    v.literal("new_criterion"),
  ),
});

export const conditionClass = v.union(
  v.literal("new"),
  v.literal("used"),
  v.literal("refurbished"),
  v.literal("unknown"),
);

export const enrichmentStatus = v.union(
  v.literal("resolving"),
  v.literal("enriching"),
  v.literal("ready"),
  v.literal("partial"),
);

export const targetAppliesTo = v.union(v.literal("item_price"), v.literal("all_in"));

export const decision = v.object({
  priorities: v.array(v.string()),
  targetCents: v.optional(v.number()),
  targetAppliesTo: v.optional(targetAppliesTo),
  updatedAt: v.number(),
});

export const actor = v.union(v.literal("app"), v.literal("agent"));

export const quote = v.object({
  retailer: v.string(),
  retailerName: v.string(),
  seller: v.string(),
  productTitle: v.string(),
  variantLabel: v.string(),
  imageUrl: v.optional(v.string()),
  quantity: v.number(),
  unitPriceCents: v.number(),
  subtotalCents: v.number(),
  taxCents: v.number(),
  shippingCents: v.number(),
  totalCents: v.number(),
  currency: v.string(),
  deliveryEstimate: v.string(),
  returnSummary: v.string(),
  quotedAt: v.number(),
  simulated: v.boolean(),
});
export type Quote = Infer<typeof quote>;

export const purchaseStatus = v.union(
  v.literal("quoting"),
  v.literal("pending_approval"),
  v.literal("approved"),
  v.literal("deferred"),
  v.literal("expired"),
  v.literal("ordered"),
  v.literal("failed"),
);
export type PurchaseStatus = Infer<typeof purchaseStatus>;

export const orderStatus = v.union(
  v.literal("awaiting_payment"),
  v.literal("submitting"),
  v.literal("awaiting_client"),
  v.literal("placed"),
  v.literal("unknown"),
  v.literal("requote_required"),
  v.literal("failed"),
);

export const shipmentEvent = v.object({
  status: v.string(),
  description: v.string(),
  location: v.union(v.string(), v.null()),
  occurredAt: v.number(),
});

export const shipmentStatus = v.union(
  v.literal("ordered"),
  v.literal("shipped"),
  v.literal("out_for_delivery"),
  v.literal("delivered"),
);

/** Whop-for-Platforms money movement: one subaccount per funded shopper. */
export const subaccountStatus = v.union(
  v.literal("pending_kyc"),
  v.literal("active"),
  v.literal("restricted"),
  v.literal("failed"),
);
export type SubaccountStatus = Infer<typeof subaccountStatus>;

export const cardStatus = v.union(
  v.literal("none"),
  v.literal("requested"),
  v.literal("active"),
  v.literal("blocked"),
  v.literal("unsupported"),
);
export type CardStatus = Infer<typeof cardStatus>;

export const paymentStatus = v.union(
  v.literal("pending"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("refunded"),
  v.literal("partially_refunded"),
  v.literal("disputed"),
);
export type PaymentStatus = Infer<typeof paymentStatus>;

export const cardTransactionStatus = v.union(
  v.literal("processing"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("released"),
);
export type CardTransactionStatus = Infer<typeof cardTransactionStatus>;

/** Outcome of re-reading the retailer page just before money moves. */
export const revalidation = v.object({
  status: v.union(v.literal("unchanged"), v.literal("changed"), v.literal("unavailable")),
  checkedAt: v.number(),
  totalCents: v.union(v.number(), v.null()),
  note: v.union(v.string(), v.null()),
});
export type Revalidation = Infer<typeof revalidation>;
