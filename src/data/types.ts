/**
 * Types mirror the Convex contract in project-mobilehack/handoffs/api-contract.md (backend PR #3).
 * They are the subset the UI reads; the backend returns supersets (sections, decision, pendingRequest),
 * which still type-check against these. Money is integer cents, timestamps are ms since epoch,
 * and eta is a YYYY-MM-DD date string.
 */

export type Currency = 'USD';

export interface Offer {
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
  currency: Currency;
  deliveryEstimate: string;
  returnSummary: string;
  rating: { average: number; count: number } | null;
  inStock: boolean;
  purchasable?: boolean;
  simulated: boolean;
  updatedAt: number;
}

export interface Product {
  id: string;
  title: string;
  brand: string | null;
  category: string;
  imageUrl: string | null;
  description: string | null;
}

export interface Rating {
  average: number;
  count: number;
  retailers: { retailerName: string; average: number; count: number }[];
}

export interface Price {
  currentCents: number;
  listPriceCents: number | null;
  currency: Currency;
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
  estimated: true;
}

export interface PricePoint {
  observedAt: number;
  priceCents: number;
  source: string;
  simulated: boolean;
}

export interface PriceHistory {
  points: PricePoint[];
  lowCents: number;
  highCents: number;
  currentCents: number;
}

export interface CartItem {
  id: string;
  url: string;
  status: 'active' | 'purchased';
  quantity: number;
  reason: string | null;
  addedBy: 'app' | 'agent';
  addedAt: number;
  enrichmentStatus: 'resolving' | 'enriching' | 'ready' | 'partial';
  product: Product | null;
  variant: { id: string; label: string } | null;
  offer: Offer | null;
  offers: Offer[];
  rating: Rating | null;
  price: Price | null;
  priceHistory: PriceHistory | null;
  pendingRequest?: { requestId: string; quoteVersion: number; totalCents: number | null; expiresAt: number } | null;
}

export interface Quote {
  retailer: string;
  retailerName: string;
  seller: string;
  productTitle: string;
  variantLabel: string | null;
  imageUrl?: string | null;
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
  simulated: boolean;
}

export type ShipmentStatus = 'ordered' | 'shipped' | 'out_for_delivery' | 'delivered';

export interface Shipment {
  status: ShipmentStatus;
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  eta: string | null;
  updatedAt: number;
  simulated: boolean;
  events?: ShipmentEvent[];
}

export interface Order {
  orderId: string;
  orderRef: string;
  status: 'submitting' | 'placed' | 'unknown' | 'requote_required' | 'failed';
  retailerOrderId: string | null;
  placedAt: number | null;
  simulated: boolean;
}

export interface PurchaseRequest {
  requestId: string;
  itemId: string;
  offerId: string;
  status: 'quoting' | 'pending_approval' | 'approved' | 'deferred' | 'expired' | 'ordered' | 'failed';
  requestedBy: 'app' | 'agent';
  reason: string;
  quantity: number;
  quoteVersion: number;
  quote: Quote | null;
  expiresAt: number;
  decidedAt: number | null;
  requestedAt: number;
  error: string | null;
  order: Order | null;
  shipment: Shipment | null;
}

export type DecideOutcome = 'approved' | 'already_approved' | 'deferred' | 'stale_quote' | 'expired' | 'invalid_state';

export interface Purchase {
  orderId: string;
  orderRef: string;
  requestId: string;
  itemId: string;
  status: Order['status'];
  retailerOrderId: string | null;
  placedAt: number | null;
  quote: Quote;
  simulated: boolean;
  shipment: Shipment | null;
}

/** A carrier scan, oldest first. status is usually a ShipmentStatus; client-reported carriers may send others. */
export interface ShipmentEvent {
  status: string;
  description: string;
  location: string | null;
  occurredAt: number;
}

export type ReviewSource = 'reddit' | 'x' | 'amazon' | 'bestbuy' | 'youtube' | 'other';

export interface Review {
  id: string;
  source: ReviewSource;
  sourceName: string;
  author: string | null;
  text: string;
  rating: number | null;
  postedAt: number | null;
  url: string;
  score: number | null;
  simulated: boolean;
}

/** reviews:list: newest first, deduped by url and text; partial while enrichment runs. bySource counts returned rows. */
export interface ReviewList {
  reviews: Review[];
  bySource: { source: ReviewSource; count: number; average: number | null }[];
}

