import type { Quote } from "../lib/validators";

/**
 * Retailer integration seam. The default is SimulatedAmazonAdapter
 * (convex/retail/simulatedAmazon.ts). A live adapter implements this
 * interface and is registered in convex/retail/index.ts.
 *
 * Adapters run inside Convex actions (default runtime, fetch available).
 * They must never return payment or shipping-address details.
 */
export type OfferSnapshot = {
  offerId: string;
  retailer: string;
  retailerName: string;
  seller: string;
  url: string;
  canonicalKey: string;
  productTitle: string;
  variantLabel: string;
  imageUrl?: string;
  priceCents: number;
  shippingCents: number;
  currency: string;
  deliveryEstimate: string;
  returnSummary: string;
  inStock: boolean;
};

export type PlaceOrderResult =
  | { status: "placed"; retailerOrderId: string; placedAt: number }
  | { status: "unknown"; detail?: string }
  | { status: "rejected"; reason: string };

export type ShipmentInfo = {
  status: "ordered" | "shipped" | "out_for_delivery" | "delivered";
  carrier?: string;
  trackingNumber?: string;
  trackingUrl?: string;
  eta?: string;
};

export type OrderStatusResult =
  | { status: "not_found" }
  | {
      status: "placed";
      retailerOrderId: string;
      placedAt: number;
      shipment: ShipmentInfo;
    };

export interface RetailerAdapter {
  readonly id: string;
  readonly simulated: boolean;
  /** Price the exact offer and quantity right now. */
  getQuote(input: { offer: OfferSnapshot; quantity: number }): Promise<Quote>;
  /**
   * Place the order. Must be idempotent on orderRef: a second call with the
   * same orderRef returns the original order, never a second one.
   */
  placeOrder(input: {
    orderRef: string;
    offer: OfferSnapshot;
    quote: Quote;
  }): Promise<PlaceOrderResult>;
  /** Look an order up by our stable orderRef (used to reconcile before retry). */
  getOrderStatus(input: { orderRef: string }): Promise<OrderStatusResult>;
}

/** Terms whose change requires the shopper to approve again. */
export function materialTermsChanged(approved: Quote, fresh: Quote): string[] {
  const changed: string[] = [];
  if (approved.totalCents !== fresh.totalCents) changed.push("totalCents");
  if (approved.seller !== fresh.seller) changed.push("seller");
  if (approved.variantLabel !== fresh.variantLabel) changed.push("variantLabel");
  if (approved.quantity !== fresh.quantity) changed.push("quantity");
  if (approved.currency !== fresh.currency) changed.push("currency");
  return changed;
}
