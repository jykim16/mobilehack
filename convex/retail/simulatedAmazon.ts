import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Quote } from "../lib/validators";
import type {
  OfferSnapshot,
  OrderStatusResult,
  PlaceOrderResult,
  RetailerAdapter,
} from "./adapter";
import { estimateTotals } from "./pricing";

/** USPS-style scan sequence. Compressed so the timeline advances during the demo. */
const SCANS: { at: number; status: "ordered" | "shipped" | "out_for_delivery" | "delivered"; description: string; location: string }[] = [
  { at: 0, status: "ordered", description: "Shipping label created, USPS awaiting item", location: "SEATTLE, WA" },
  { at: 25_000, status: "shipped", description: "USPS in possession of item", location: "SEATTLE, WA" },
  { at: 45_000, status: "shipped", description: "Departed USPS Regional Facility", location: "AUBURN, WA" },
  { at: 70_000, status: "shipped", description: "Arrived at USPS Regional Facility", location: "SAN FRANCISCO, CA" },
  { at: 90_000, status: "out_for_delivery", description: "Out for Delivery, Expected Delivery by 8:00pm", location: "SAN FRANCISCO, CA" },
  { at: 110_000, status: "delivered", description: "Delivered, Front Door/Porch", location: "SAN FRANCISCO, CA" },
];

function etaFor(placedAt: number) {
  return new Date(placedAt).toISOString().slice(0, 10);
}

/**
 * SIMULATED retailer checkout. No real order is placed anywhere. Orders live
 * in the simulatedRetailerOrders table, keyed by orderRef, to model a retailer
 * that deduplicates on our reference.
 */
export class SimulatedAmazonAdapter implements RetailerAdapter {
  readonly id = "simulated";
  readonly simulated = true;
  constructor(private ctx: ActionCtx) {}

  async getQuote({ offer, quantity }: { offer: OfferSnapshot; quantity: number }): Promise<Quote> {
    const totals = estimateTotals(offer.priceCents, offer.shippingCents, quantity);
    return {
      retailer: offer.retailer,
      retailerName: offer.retailerName,
      seller: offer.seller,
      productTitle: offer.productTitle,
      variantLabel: offer.variantLabel,
      imageUrl: offer.imageUrl,
      quantity,
      unitPriceCents: offer.priceCents,
      ...totals,
      currency: offer.currency,
      deliveryEstimate: offer.deliveryEstimate,
      returnSummary: offer.returnSummary,
      quotedAt: Date.now(),
      simulated: true,
    };
  }

  async placeOrder({ orderRef, offer }: { orderRef: string; offer: OfferSnapshot; quote: Quote }): Promise<PlaceOrderResult> {
    if (!offer.inStock) return { status: "rejected", reason: "Out of stock" };
    const placed = await this.ctx.runMutation(internal.retail.simulatedStore.place, {
      orderRef,
      retailer: offer.retailer,
    });
    return { status: "placed", retailerOrderId: placed.retailerOrderId, placedAt: placed.placedAt };
  }

  async getOrderStatus({ orderRef }: { orderRef: string }): Promise<OrderStatusResult> {
    const found = await this.ctx.runQuery(internal.retail.simulatedStore.get, { orderRef });
    if (!found) return { status: "not_found" };
    const elapsed = Date.now() - found.placedAt;
    const scans = SCANS.filter((s) => elapsed >= s.at);
    const current = scans[scans.length - 1];
    return {
      status: "placed",
      retailerOrderId: found.retailerOrderId,
      placedAt: found.placedAt,
      shipment: {
        status: current.status,
        carrier: "USPS (simulated)",
        trackingNumber: found.trackingNumber,
        trackingUrl: `https://tools.usps.com/go/TrackConfirmAction?tLabels=${found.trackingNumber}`,
        eta: etaFor(found.placedAt),
        events: scans.map((s) => ({
          status: s.status,
          description: s.description,
          location: s.location,
          occurredAt: found.placedAt + s.at,
        })),
      },
    };
  }
}
