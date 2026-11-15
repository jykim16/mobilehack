import type { Currency, Quote, Shipment, ShipmentEvent, ShipmentStatus } from './types';

/**
 * Exact client-to-Convex sync payloads aligned with `MOBI-1` / `MOBI-9`:
 * - `api.purchases.attachClientQuote({ requestId, quoteVersion, quote })`
 * - `api.orders.recordClientPlacement({ orderRef, retailerOrderId, placedAt, shipment? })`
 * - `api.orders.syncClientShipment({ orderRef?, retailerOrderId, shipment })`
 *
 * Kept free of `convex/` runtime imports so `src/amazon/` merges cleanly before or after
 * `MOBI-9`'s client-sync PR lands, and wires in with 5 lines on `<AmazonBrowserProvider convexSync={...}>`.
 */

export interface ConvexClientQuotePayload {
  retailer: string;
  retailerName: string;
  seller: string;
  productTitle: string;
  variantLabel: string | null;
  imageUrl: string | null;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  currency: Currency;
  deliveryEstimate: string;
  returnSummary: string;
  quotedAt: number;
  simulated: false;
}

export interface ConvexClientShipmentPayload {
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  eta: string | null;
  events: ShipmentEvent[];
  updatedAt: number;
  simulated: false;
}

export interface AttachClientQuoteArgs {
  requestId: string;
  quoteVersion: number;
  quote: ConvexClientQuotePayload;
}

export interface RecordClientPlacementArgs {
  orderRef: string;
  retailerOrderId: string;
  placedAt: number;
  shipment?: ConvexClientShipmentPayload;
}

export interface SyncClientShipmentArgs {
  orderRef?: string;
  retailerOrderId: string;
  shipment: ConvexClientShipmentPayload;
}

export interface ConvexAmazonSyncClient {
  attachClientQuote?: (args: AttachClientQuoteArgs) => Promise<unknown>;
  recordClientPlacement?: (args: RecordClientPlacementArgs) => Promise<unknown>;
  syncClientShipment?: (args: SyncClientShipmentArgs) => Promise<unknown>;
}

export function toConvexClientQuote(quote: Quote): ConvexClientQuotePayload {
  return {
    retailer: quote.retailer,
    retailerName: quote.retailerName,
    seller: quote.seller,
    productTitle: quote.productTitle,
    variantLabel: quote.variantLabel ?? null,
    imageUrl: quote.imageUrl ?? null,
    quantity: quote.quantity,
    unitPriceCents: Math.round(quote.unitPriceCents),
    subtotalCents: Math.round(quote.subtotalCents),
    taxCents: Math.round(quote.taxCents),
    shippingCents: Math.round(quote.shippingCents),
    totalCents: Math.round(quote.totalCents),
    currency: quote.currency,
    deliveryEstimate: quote.deliveryEstimate,
    returnSummary: quote.returnSummary,
    quotedAt: quote.quotedAt,
    simulated: false,
  };
}

export function toConvexClientShipment(shipment: Shipment): ConvexClientShipmentPayload {
  const sortedEvents = [...shipment.events].sort((a, b) => a.occurredAt - b.occurredAt);
  return {
    status: shipment.status,
    carrier: shipment.carrier ?? null,
    trackingNumber: shipment.trackingNumber ?? null,
    trackingUrl: shipment.trackingUrl ?? null,
    eta: shipment.eta ?? null,
    events: sortedEvents.map((ev) => ({
      status: ev.status,
      description: ev.description,
      location: ev.location ?? null,
      occurredAt: ev.occurredAt,
    })),
    updatedAt: shipment.updatedAt,
    simulated: false,
  };
}

export function buildAttachClientQuoteArgs(input: {
  requestId: string;
  quoteVersion: number;
  quote: Quote;
}): AttachClientQuoteArgs {
  return {
    requestId: input.requestId,
    quoteVersion: input.quoteVersion,
    quote: toConvexClientQuote(input.quote),
  };
}

export function buildRecordClientPlacementArgs(input: {
  orderRef: string;
  retailerOrderId: string;
  placedAt: number;
  shipment?: Shipment | null;
}): RecordClientPlacementArgs {
  return {
    orderRef: input.orderRef,
    retailerOrderId: input.retailerOrderId,
    placedAt: input.placedAt,
    ...(input.shipment ? { shipment: toConvexClientShipment(input.shipment) } : {}),
  };
}

export function buildSyncClientShipmentArgs(input: {
  orderRef?: string | null;
  retailerOrderId: string;
  shipment: Shipment;
}): SyncClientShipmentArgs {
  return {
    ...(input.orderRef ? { orderRef: input.orderRef } : {}),
    retailerOrderId: input.retailerOrderId,
    shipment: toConvexClientShipment(input.shipment),
  };
}
