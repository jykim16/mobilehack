export const MIN_CLARIFICATION_QUESTIONS = 1;
export const MAX_CLARIFICATION_QUESTIONS = 4;

export type ChatThreadStatus =
  | "idle"
  | "running"
  | "awaiting_clarification"
  | "awaiting_approval"
  | "error";

export type SectionName =
  | "categoryGuidance"
  | "returnTerms"
  | "priceHistory"
  | "retailerReviews"
  | "reddit";

export type SectionStatus = "pending" | "running" | "ready" | "failed";

export type HighlightTone = "positive" | "negative" | "neutral" | "new_criterion";

export type SectionHighlight = {
  label: string;
  detail: string;
  tone: HighlightTone;
};

export type SectionSource = {
  title: string;
  url: string;
  publisher?: string;
};

export type Section = {
  section: SectionName;
  status: SectionStatus;
  checkedAt: number | null;
  simulated: boolean;
  summary?: string | null;
  scope?: "product" | "offer";
  error?: string | null;
  highlights?: SectionHighlight[];
  sources?: SectionSource[];
};

export type Offer = {
  id: string;
  retailer: string;
  retailerName: string;
  seller: string;
  url: string;
  variantId: string;
  variantLabel: string | null;
  priceCents: number;
  listPriceCents: number | null;
  shippingCents: number;
  currency: string;
  deliveryEstimate: string;
  returnSummary: string;
  rating: { average: number; count: number } | null;
  inStock: boolean;
  purchasable?: boolean;
  simulated: boolean;
  updatedAt: number;
};

export type PricePoint = {
  observedAt: number;
  priceCents: number;
  source: string;
  simulated: boolean;
};

export type CartItem = {
  id: string;
  url: string;
  status: "active" | "purchased" | "removed";
  quantity: number;
  reason: string | null;
  addedBy: "app" | "agent";
  addedAt: number;
  enrichmentStatus: "resolving" | "enriching" | "ready" | "partial";
  product: {
    id: string;
    title: string;
    brand: string | null;
    category: string;
    imageUrl: string | null;
    description: string | null;
  } | null;
  variant: {
    id: string;
    label: string;
  } | null;
  offer: Offer | null;
  offers: Offer[];
  rating: {
    average: number;
    count: number;
    retailers: { retailerName: string; average: number; count: number }[];
  } | null;
  price: {
    currentCents: number;
    listPriceCents: number | null;
    currency: string;
    subtotalCents: number;
    taxCents: number;
    shippingCents: number;
    totalCents: number;
    estimated: boolean;
  } | null;
  priceHistory: {
    points: PricePoint[];
    lowCents: number;
    highCents: number;
    currentCents: number;
  } | null;
  decision: {
    priorities: string[];
    targetCents: number | null;
    targetAppliesTo: "item_price" | "all_in" | null;
    targetMet: boolean | null;
    updatedAt: number;
  } | null;
  sections: Section[];
  pendingRequest: {
    requestId: string;
    quoteVersion: number;
    totalCents: number | null;
    expiresAt: number;
  } | null;
};

export type Quote = {
  retailer: string;
  retailerName: string;
  seller: string;
  productTitle: string;
  variantLabel: string;
  imageUrl?: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: string;
  deliveryEstimate: string;
  returnSummary: string;
  quotedAt: number;
  simulated: boolean;
};

export type OrderStatus =
  | "submitting"
  | "placed"
  | "unknown"
  | "requote_required"
  | "failed";

export type ShipmentStatus = "ordered" | "shipped" | "out_for_delivery" | "delivered";

export type ShipmentSummary = {
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  eta: string | null;
  updatedAt: number;
  simulated: boolean;
};

export type PurchaseRequest = {
  requestId: string;
  itemId: string;
  offerId: string;
  status:
    | "quoting"
    | "pending_approval"
    | "approved"
    | "deferred"
    | "expired"
    | "ordered"
    | "failed";
  requestedBy: "app" | "agent";
  reason: string;
  quantity: number;
  quoteVersion: number;
  quote: Quote | null;
  expiresAt: number;
  decidedAt: number | null;
  requestedAt: number;
  error: string | null;
  order: {
    orderId: string;
    orderRef: string;
    status: OrderStatus;
    retailerOrderId: string | null;
    placedAt: number | null;
    simulated: boolean;
  } | null;
  shipment: ShipmentSummary | null;
};

export type Purchase = {
  orderId: string;
  orderRef: string;
  requestId: string;
  itemId: string;
  status: OrderStatus;
  retailerOrderId: string | null;
  placedAt: number | null;
  quote: Quote;
  simulated: boolean;
  shipment: ShipmentSummary | null;
};

export type DecidePurchaseOutcome =
  | "approved"
  | "already_approved"
  | "deferred"
  | "stale_quote"
  | "expired"
  | "invalid_state";

export type ClarificationOption = {
  id: string;
  label: string;
  description?: string;
  value: string;
};

export type ClarificationQuestion = {
  id: string;
  prompt: string;
  kind: "single_select" | "multi_select" | "price_range";
  options: ClarificationOption[];
  allowFreeform?: boolean;
  priceRangePreset?: {
    minCents: number;
    maxCents: number;
    stepCents: number;
    defaultMaxCents?: number;
    currency: "USD";
    appliesTo: "all_in" | "item_price";
  };
};

export type ClarificationRequestCard = {
  kind: "clarification_request";
  clarificationId: string;
  status: "pending" | "answered" | "skipped";
  questions: ClarificationQuestion[];
  answers?: Record<string, string | string[]>;
};

export type ProductEvidenceCard = {
  kind: "product_evidence";
  itemId: string;
  item: CartItem;
  featuredSection?: SectionName;
};

export type PriceHistoryCard = {
  kind: "price_history";
  itemId: string;
  productTitle: string;
  variantLabel: string | null;
  retailerName: string;
  currentCents: number;
  allInTotalCents: number | null;
  lowCents: number;
  highCents: number;
  targetCents: number | null;
  targetAppliesTo: "item_price" | "all_in" | null;
  targetMet: boolean | null;
  points: PricePoint[];
  simulated: boolean;
};

export type CartActionCard = {
  kind: "cart_action";
  action: "added" | "updated_decision" | "quantity_changed" | "removed";
  itemId: string;
  productTitle: string;
  variantLabel: string | null;
  retailerName: string;
  quantity: number;
  priceCents: number | null;
  deduplicated?: boolean;
  enrichmentStatus?: "resolving" | "enriching" | "ready" | "partial";
};

export type CheckoutApprovalCard = {
  kind: "checkout_approval";
  requestId: string;
  itemId: string;
  offerId: string;
  quoteVersion: number;
  expiresAt: number;
  status: "pending_approval" | "approved" | "deferred" | "expired" | "stale";
  quote: Quote;
  reason: string;
  amazonSignInRequired: boolean;
};

export type OrderReceiptCard = {
  kind: "order_receipt";
  orderId: string;
  orderRef: string;
  requestId: string;
  itemId: string;
  status: OrderStatus;
  quote: Quote;
  shipment: ShipmentSummary | null;
  simulated: boolean;
};

export type AgentCard =
  | ClarificationRequestCard
  | ProductEvidenceCard
  | PriceHistoryCard
  | CartActionCard
  | CheckoutApprovalCard
  | OrderReceiptCard;

export type AmazonLiveOffer = {
  asin?: string;
  url: string;
  title: string;
  variantLabel?: string | null;
  priceCents: number;
  shippingCents?: number;
  deliveryEstimate?: string;
  returnSummary?: string;
  inStock?: boolean;
};

export type AmazonSessionContext = {
  status: "connected" | "signed_out" | "busy";
  lastSyncedAt?: number | null;
  liveOffers?: AmazonLiveOffer[];
};

export type AmazonClientAction =
  | { type: "amazon_prompt_sign_in"; reason: string }
  | {
      type: "amazon_sync_cart_add";
      url: string;
      asin?: string;
      variantLabel?: string | null;
      quantity: number;
    }
  | { type: "amazon_refresh_orders" };

export type ChatMessage = {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  text: string;
  cards: AgentCard[];
  clientActions?: AmazonClientAction[];
  status: "streaming" | "complete" | "error";
  createdAt: number;
};

export function formatCents(cents: number, currency = "USD"): string {
  if (currency === "USD") {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

export function summarizeClarificationAnswers(card: ClarificationRequestCard): string {
  if (card.status === "skipped") return "Skipped preferences";
  if (!card.answers || Object.keys(card.answers).length === 0) return "Preferences saved";

  const labels: string[] = [];
  for (const [key, rawVal] of Object.entries(card.answers)) {
    const vals = Array.isArray(rawVal) ? rawVal : [rawVal];
    const question = card.questions.find((q) => q.id === key);
    for (const val of vals) {
      const matchedOpt = question?.options.find((o) => o.value === val);
      if (matchedOpt) {
        labels.push(matchedOpt.label);
      } else if (/^\d+$/.test(val) && Number(val) >= 1000) {
        labels.push(`Under ${formatCents(Number(val))}`);
      } else if (val.trim()) {
        labels.push(val.trim());
      }
    }
  }
  return labels.length > 0 ? labels.join(" · ") : "Preferences saved";
}

function isIntegerCents(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

export function validateAgentCard(card: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!card || typeof card !== "object") {
    return { valid: false, errors: ["Card must be an object."] };
  }
  const c = card as Record<string, unknown>;
  switch (c.kind) {
    case "clarification_request": {
      if (typeof c.clarificationId !== "string" || !c.clarificationId) {
        errors.push("clarification_request missing clarificationId");
      }
      if (!["pending", "answered", "skipped"].includes(String(c.status))) {
        errors.push(`invalid clarification status: ${String(c.status)}`);
      }
      if (!Array.isArray(c.questions)) {
        errors.push("clarification_request.questions must be an array");
      } else {
        if (
          c.questions.length < MIN_CLARIFICATION_QUESTIONS ||
          c.questions.length > MAX_CLARIFICATION_QUESTIONS
        ) {
          errors.push(
            `clarification_request.questions length must be 1..4, got ${c.questions.length}`,
          );
        }
        for (const q of c.questions as Record<string, unknown>[]) {
          if (typeof q.id !== "string" || typeof q.prompt !== "string") {
            errors.push("clarification question missing id or prompt");
          }
          if (!["single_select", "multi_select", "price_range"].includes(String(q.kind))) {
            errors.push(`invalid question kind: ${String(q.kind)}`);
          }
          if (!Array.isArray(q.options) || q.options.length === 0) {
            errors.push(`question ${String(q.id)} must include options`);
          }
          if (q.priceRangePreset && typeof q.priceRangePreset === "object") {
            const pr = q.priceRangePreset as Record<string, unknown>;
            if (
              !isIntegerCents(pr.minCents) ||
              !isIntegerCents(pr.maxCents) ||
              !isIntegerCents(pr.stepCents) ||
              pr.currency !== "USD"
            ) {
              errors.push(`question ${String(q.id)} has invalid priceRangePreset`);
            }
          }
        }
      }
      break;
    }
    case "cart_action": {
      if (!["added", "updated_decision", "quantity_changed", "removed"].includes(String(c.action))) {
        errors.push(`invalid cart_action.action: ${String(c.action)}`);
      }
      if (typeof c.itemId !== "string" || typeof c.productTitle !== "string") {
        errors.push("cart_action missing itemId or productTitle");
      }
      if (c.priceCents !== null && !isIntegerCents(c.priceCents)) {
        errors.push("cart_action.priceCents must be integer cents or null");
      }
      break;
    }
    case "product_evidence": {
      if (typeof c.itemId !== "string" || !c.item || typeof c.item !== "object") {
        errors.push("product_evidence missing itemId or item");
      } else {
        const item = c.item as Record<string, unknown>;
        if (!Array.isArray(item.sections) || item.sections.length !== 5) {
          errors.push("product_evidence.item.sections must have all 5 sections");
        }
        if (item.price && typeof item.price === "object") {
          const pr = item.price as Record<string, unknown>;
          if (!isIntegerCents(pr.totalCents) || pr.currency !== "USD") {
            errors.push("product_evidence.item.price must use integer cents in USD");
          }
        }
      }
      break;
    }
    case "price_history": {
      if (
        typeof c.itemId !== "string" ||
        !isIntegerCents(c.currentCents) ||
        !isIntegerCents(c.lowCents) ||
        !isIntegerCents(c.highCents) ||
        typeof c.simulated !== "boolean" ||
        !Array.isArray(c.points)
      ) {
        errors.push("price_history has invalid integer cent bounds or simulated flag");
      }
      break;
    }
    case "checkout_approval": {
      if (
        typeof c.requestId !== "string" ||
        typeof c.itemId !== "string" ||
        typeof c.offerId !== "string" ||
        typeof c.quoteVersion !== "number" ||
        typeof c.amazonSignInRequired !== "boolean" ||
        !c.quote ||
        typeof c.quote !== "object"
      ) {
        errors.push("checkout_approval missing required quote-binding fields");
      } else {
        const q = c.quote as Record<string, unknown>;
        if (
          !isIntegerCents(q.unitPriceCents) ||
          !isIntegerCents(q.subtotalCents) ||
          !isIntegerCents(q.taxCents) ||
          !isIntegerCents(q.shippingCents) ||
          !isIntegerCents(q.totalCents) ||
          q.currency !== "USD" ||
          typeof q.simulated !== "boolean"
        ) {
          errors.push("checkout_approval.quote must use integer cents in USD with simulated flag");
        }
      }
      break;
    }
    case "order_receipt": {
      if (
        typeof c.orderId !== "string" ||
        typeof c.orderRef !== "string" ||
        typeof c.requestId !== "string" ||
        typeof c.itemId !== "string" ||
        typeof c.simulated !== "boolean" ||
        !c.quote ||
        typeof c.quote !== "object"
      ) {
        errors.push("order_receipt missing required fields");
      }
      break;
    }
    default:
      errors.push(`unknown AgentCard kind: ${String(c.kind)}`);
  }

  return { valid: errors.length === 0, errors };
}

export function validateChatMessage(msg: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (!msg || typeof msg !== "object") {
    return { valid: false, errors: ["ChatMessage must be an object."] };
  }
  const m = msg as Record<string, unknown>;
  if (typeof m.id !== "string" || typeof m.threadId !== "string") {
    errors.push("ChatMessage missing id or threadId");
  }
  if (m.role !== "user" && m.role !== "assistant") {
    errors.push(`invalid ChatMessage.role: ${String(m.role)}`);
  }
  if (typeof m.text !== "string") {
    errors.push("ChatMessage.text must be a string");
  }
  if (!["streaming", "complete", "error"].includes(String(m.status))) {
    errors.push(`invalid ChatMessage.status: ${String(m.status)}`);
  }
  if (typeof m.createdAt !== "number") {
    errors.push("ChatMessage.createdAt must be epoch ms");
  }
  if (!Array.isArray(m.cards)) {
    errors.push("ChatMessage.cards must be an array");
  } else {
    for (const card of m.cards) {
      const cardCheck = validateAgentCard(card);
      if (!cardCheck.valid) {
        errors.push(...cardCheck.errors);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}
