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

export const SIMULATED_SHIP_DELAY_MS = 20_000;

function etaFrom(ms: number) {
  return new Date(ms + 3 * 24 * 3600_000).toISOString().slice(0, 10);
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
    const shipped = Date.now() - found.placedAt >= SIMULATED_SHIP_DELAY_MS;
    return {
      status: "placed",
      retailerOrderId: found.retailerOrderId,
      placedAt: found.placedAt,
      shipment: shipped
        ? {
            status: "shipped",
            carrier: "UPS (simulated)",
            trackingNumber: found.trackingNumber,
            trackingUrl: `https://www.ups.com/track?tracknum=${found.trackingNumber}`,
            eta: etaFrom(found.placedAt),
          }
        : { status: "ordered", eta: etaFrom(found.placedAt) },
    };
  }
}
