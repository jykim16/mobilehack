import { v } from "convex/values";

/**
 * Payloads the shopper's device sends after driving the live Amazon site in its
 * own WKWebView (owned by the Amazon Integration thread). Amounts are integer
 * cents, times are epoch ms, eta is YYYY-MM-DD.
 */
export const clientQuote = v.object({
  retailer: v.string(),
  retailerName: v.string(),
  seller: v.string(),
  productTitle: v.string(),
  variantLabel: v.union(v.string(), v.null()),
  imageUrl: v.union(v.string(), v.null()),
  quantity: v.number(),
  unitPriceCents: v.number(),
  subtotalCents: v.number(),
  taxCents: v.number(),
  shippingCents: v.number(),
  totalCents: v.number(),
  currency: v.literal("USD"),
  deliveryEstimate: v.string(),
  returnSummary: v.string(),
  quotedAt: v.number(),
  simulated: v.literal(false),
});

export const clientShipmentEvent = v.object({
  status: v.string(),
  description: v.string(),
  location: v.union(v.string(), v.null()),
  occurredAt: v.number(),
});

export const clientShipment = v.object({
  status: v.union(
    v.literal("ordered"),
    v.literal("shipped"),
    v.literal("out_for_delivery"),
    v.literal("delivered"),
  ),
  carrier: v.union(v.string(), v.null()),
  trackingNumber: v.union(v.string(), v.null()),
  trackingUrl: v.union(v.string(), v.null()),
  eta: v.union(v.string(), v.null()),
  events: v.array(clientShipmentEvent),
  updatedAt: v.number(),
  simulated: v.literal(false),
});
