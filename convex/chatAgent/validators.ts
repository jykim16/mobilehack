import { ConvexError, v, type Infer } from "convex/values";
import {
  actor,
  enrichmentStatus,
  evidenceScope,
  highlight,
  orderStatus,
  quote,
  sectionName,
  sectionStatus,
  shipmentStatus,
  source,
  targetAppliesTo,
} from "../lib/validators";

export const MIN_CLARIFICATION_QUESTIONS = 1;
export const MAX_CLARIFICATION_QUESTIONS = 4;

export const chatThreadStatusValidator = v.union(
  v.literal("idle"),
  v.literal("running"),
  v.literal("awaiting_clarification"),
  v.literal("awaiting_approval"),
  v.literal("error"),
);
export type ChatThreadStatus = Infer<typeof chatThreadStatusValidator>;

export const chatMessageRoleValidator = v.union(v.literal("user"), v.literal("assistant"));
export type ChatMessageRole = Infer<typeof chatMessageRoleValidator>;

export const chatMessageStatusValidator = v.union(
  v.literal("streaming"),
  v.literal("complete"),
  v.literal("error"),
);
export type ChatMessageStatus = Infer<typeof chatMessageStatusValidator>;

export const amazonLiveOfferValidator = v.object({
  asin: v.optional(v.string()),
  url: v.string(),
  title: v.string(),
  variantLabel: v.optional(v.union(v.string(), v.null())),
  priceCents: v.number(),
  shippingCents: v.optional(v.number()),
  deliveryEstimate: v.optional(v.string()),
  returnSummary: v.optional(v.string()),
  inStock: v.optional(v.boolean()),
});

export const amazonSessionContextValidator = v.object({
  status: v.union(v.literal("connected"), v.literal("signed_out"), v.literal("busy")),
  lastSyncedAt: v.optional(v.union(v.number(), v.null())),
  liveOffers: v.optional(v.array(amazonLiveOfferValidator)),
});
export type AmazonSessionContext = Infer<typeof amazonSessionContextValidator>;

export const amazonClientActionValidator = v.union(
  v.object({
    type: v.literal("amazon_prompt_sign_in"),
    reason: v.string(),
  }),
  v.object({
    type: v.literal("amazon_sync_cart_add"),
    url: v.string(),
    asin: v.optional(v.string()),
    variantLabel: v.optional(v.union(v.string(), v.null())),
    quantity: v.number(),
  }),
  v.object({
    type: v.literal("amazon_refresh_orders"),
  }),
);
export type AmazonClientAction = Infer<typeof amazonClientActionValidator>;

export const clarificationOptionValidator = v.object({
  id: v.string(),
  label: v.string(),
  description: v.optional(v.string()),
  value: v.string(),
});
export type ClarificationOption = Infer<typeof clarificationOptionValidator>;

export const priceRangePresetValidator = v.object({
  minCents: v.number(),
  maxCents: v.number(),
  stepCents: v.number(),
  defaultMaxCents: v.optional(v.number()),
  currency: v.literal("USD"),
  appliesTo: targetAppliesTo,
});
export type PriceRangePreset = Infer<typeof priceRangePresetValidator>;

export const clarificationQuestionValidator = v.object({
  id: v.string(),
  prompt: v.string(),
  kind: v.union(v.literal("single_select"), v.literal("multi_select"), v.literal("price_range")),
  options: v.array(clarificationOptionValidator),
  allowFreeform: v.optional(v.boolean()),
  priceRangePreset: v.optional(priceRangePresetValidator),
});
export type ClarificationQuestion = Infer<typeof clarificationQuestionValidator>;

export const clarificationAnswersValidator = v.record(
  v.string(),
  v.union(v.string(), v.array(v.string())),
);
export type ClarificationAnswers = Infer<typeof clarificationAnswersValidator>;

export const clarificationRequestCardValidator = v.object({
  kind: v.literal("clarification_request"),
  clarificationId: v.string(),
  status: v.union(v.literal("pending"), v.literal("answered"), v.literal("skipped")),
  questions: v.array(clarificationQuestionValidator),
  answers: v.optional(clarificationAnswersValidator),
});
export type ClarificationRequestCard = Infer<typeof clarificationRequestCardValidator>;

export const offerViewValidator = v.object({
  id: v.string(),
  retailer: v.string(),
  retailerName: v.string(),
  seller: v.string(),
  url: v.string(),
  variantId: v.string(),
  variantLabel: v.union(v.string(), v.null()),
  priceCents: v.number(),
  listPriceCents: v.union(v.number(), v.null()),
  shippingCents: v.number(),
  currency: v.string(),
  deliveryEstimate: v.string(),
  returnSummary: v.string(),
  rating: v.union(v.object({ average: v.number(), count: v.number() }), v.null()),
  inStock: v.boolean(),
  purchasable: v.optional(v.boolean()),
  simulated: v.boolean(),
  updatedAt: v.number(),
});

export const pricePointValidator = v.object({
  observedAt: v.number(),
  priceCents: v.number(),
  source: v.string(),
  simulated: v.boolean(),
});

export const sectionViewValidator = v.object({
  section: sectionName,
  status: sectionStatus,
  checkedAt: v.union(v.number(), v.null()),
  simulated: v.boolean(),
  summary: v.optional(v.union(v.string(), v.null())),
  scope: v.optional(evidenceScope),
  error: v.optional(v.union(v.string(), v.null())),
  highlights: v.optional(v.array(highlight)),
  sources: v.optional(v.array(source)),
});

export const cartItemSnapshotValidator = v.object({
  id: v.string(),
  url: v.string(),
  status: v.union(v.literal("active"), v.literal("purchased"), v.literal("removed")),
  quantity: v.number(),
  reason: v.union(v.string(), v.null()),
  addedBy: actor,
  addedAt: v.number(),
  enrichmentStatus,
  product: v.union(
    v.object({
      id: v.string(),
      title: v.string(),
      brand: v.union(v.string(), v.null()),
      category: v.string(),
      imageUrl: v.union(v.string(), v.null()),
      description: v.union(v.string(), v.null()),
    }),
    v.null(),
  ),
  variant: v.union(v.object({ id: v.string(), label: v.string() }), v.null()),
  offer: v.union(offerViewValidator, v.null()),
  offers: v.array(offerViewValidator),
  rating: v.union(
    v.object({
      average: v.number(),
      count: v.number(),
      retailers: v.array(
        v.object({
          retailerName: v.string(),
          average: v.number(),
          count: v.number(),
        }),
      ),
    }),
    v.null(),
  ),
  price: v.union(
    v.object({
      currentCents: v.number(),
      listPriceCents: v.union(v.number(), v.null()),
      currency: v.string(),
      subtotalCents: v.number(),
      taxCents: v.number(),
      shippingCents: v.number(),
      totalCents: v.number(),
      estimated: v.boolean(),
    }),
    v.null(),
  ),
  priceHistory: v.union(
    v.object({
      points: v.array(pricePointValidator),
      lowCents: v.number(),
      highCents: v.number(),
      currentCents: v.number(),
    }),
    v.null(),
  ),
  decision: v.union(
    v.object({
      priorities: v.array(v.string()),
      targetCents: v.union(v.number(), v.null()),
      targetAppliesTo: v.union(targetAppliesTo, v.null()),
      targetMet: v.union(v.boolean(), v.null()),
      updatedAt: v.number(),
    }),
    v.null(),
  ),
  sections: v.array(sectionViewValidator),
  pendingRequest: v.union(
    v.object({
      requestId: v.string(),
      quoteVersion: v.number(),
      totalCents: v.union(v.number(), v.null()),
      expiresAt: v.number(),
    }),
    v.null(),
  ),
});
export type CartItemSnapshot = Infer<typeof cartItemSnapshotValidator>;

export const productEvidenceCardValidator = v.object({
  kind: v.literal("product_evidence"),
  itemId: v.string(),
  item: cartItemSnapshotValidator,
  featuredSection: v.optional(sectionName),
});
export type ProductEvidenceCard = Infer<typeof productEvidenceCardValidator>;

export const priceHistoryCardValidator = v.object({
  kind: v.literal("price_history"),
  itemId: v.string(),
  productTitle: v.string(),
  variantLabel: v.union(v.string(), v.null()),
  retailerName: v.string(),
  currentCents: v.number(),
  allInTotalCents: v.union(v.number(), v.null()),
  lowCents: v.number(),
  highCents: v.number(),
  targetCents: v.union(v.number(), v.null()),
  targetAppliesTo: v.union(targetAppliesTo, v.null()),
  targetMet: v.union(v.boolean(), v.null()),
  points: v.array(pricePointValidator),
  simulated: v.boolean(),
});
export type PriceHistoryCard = Infer<typeof priceHistoryCardValidator>;

export const cartActionCardValidator = v.object({
  kind: v.literal("cart_action"),
  action: v.union(
    v.literal("added"),
    v.literal("updated_decision"),
    v.literal("quantity_changed"),
    v.literal("removed"),
  ),
  itemId: v.string(),
  productTitle: v.string(),
  variantLabel: v.union(v.string(), v.null()),
  retailerName: v.string(),
  quantity: v.number(),
  priceCents: v.union(v.number(), v.null()),
  deduplicated: v.optional(v.boolean()),
  enrichmentStatus: v.optional(enrichmentStatus),
});
export type CartActionCard = Infer<typeof cartActionCardValidator>;

export const checkoutApprovalCardValidator = v.object({
  kind: v.literal("checkout_approval"),
  requestId: v.string(),
  itemId: v.string(),
  offerId: v.string(),
  quoteVersion: v.number(),
  expiresAt: v.number(),
  status: v.union(
    v.literal("pending_approval"),
    v.literal("approved"),
    v.literal("deferred"),
    v.literal("expired"),
    v.literal("stale"),
  ),
  quote,
  reason: v.string(),
  amazonSignInRequired: v.boolean(),
});
export type CheckoutApprovalCard = Infer<typeof checkoutApprovalCardValidator>;

export const shipmentViewValidator = v.object({
  status: shipmentStatus,
  carrier: v.union(v.string(), v.null()),
  trackingNumber: v.union(v.string(), v.null()),
  trackingUrl: v.union(v.string(), v.null()),
  eta: v.union(v.string(), v.null()),
  updatedAt: v.number(),
  simulated: v.boolean(),
});
export type ShipmentView = Infer<typeof shipmentViewValidator>;

export const orderReceiptCardValidator = v.object({
  kind: v.literal("order_receipt"),
  orderId: v.string(),
  orderRef: v.string(),
  requestId: v.string(),
  itemId: v.string(),
  status: orderStatus,
  quote,
  shipment: v.union(shipmentViewValidator, v.null()),
  simulated: v.boolean(),
});
export type OrderReceiptCard = Infer<typeof orderReceiptCardValidator>;

export const agentCardValidator = v.union(
  clarificationRequestCardValidator,
  productEvidenceCardValidator,
  priceHistoryCardValidator,
  cartActionCardValidator,
  checkoutApprovalCardValidator,
  orderReceiptCardValidator,
);
export type AgentCard = Infer<typeof agentCardValidator>;

/**
 * Enforces the non-negotiable 1..4 clarifying-questions cap:
 * - Slices any array > 4 down to 4 (`MAX_CLARIFICATION_QUESTIONS`)
 * - Validates at least 1 question and 2..4 options per question
 */
export function enforceClarificationCap(
  questions: ClarificationQuestion[],
): ClarificationQuestion[] {
  const capped = questions.slice(0, MAX_CLARIFICATION_QUESTIONS).map((q) => ({
    ...q,
    allowFreeform: q.allowFreeform ?? true,
    options: q.options.slice(0, 4),
    priceRangePreset: q.priceRangePreset
      ? {
          ...q.priceRangePreset,
          minCents: Math.round(q.priceRangePreset.minCents),
          maxCents: Math.round(q.priceRangePreset.maxCents),
          stepCents: Math.round(q.priceRangePreset.stepCents),
          defaultMaxCents:
            q.priceRangePreset.defaultMaxCents !== undefined
              ? Math.round(q.priceRangePreset.defaultMaxCents)
              : undefined,
        }
      : undefined,
  }));
  if (capped.length < MIN_CLARIFICATION_QUESTIONS) {
    throw new ConvexError({
      code: "INVALID_STATE",
      message: "Clarification request must include between 1 and 4 questions.",
    });
  }
  return capped;
}

export function assertValidCards(cards: AgentCard[]): AgentCard[] {
  return cards.map((card) => {
    if (card.kind === "clarification_request") {
      if (
        card.questions.length < MIN_CLARIFICATION_QUESTIONS ||
        card.questions.length > MAX_CLARIFICATION_QUESTIONS
      ) {
        return {
          ...card,
          questions: enforceClarificationCap(card.questions),
        };
      }
    }
    return card;
  });
}
