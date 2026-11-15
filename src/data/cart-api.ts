import {
  TAX_RATE,
  daysFromNow,
  deliveryDaysFor,
  etaFromNow,
  findByUrl,
  offerUrl,
  returnSummaryFor,
  HERO_URL,
} from './mock-catalog';
import type {
  CartItem,
  DecideOutcome,
  Offer,
  PriceHistory,
  PricePoint,
  Purchase,
  PurchaseRequest,
  Quote,
  ShipmentStatus,
} from './types';

/**
 * In-memory stand-in for the Convex functions in api-contract.md. Each export is named after
 * and shaped like its contract call (api.cart.* and api.purchases.*), taking the same args object
 * and returning the same shape, so screens swap to useQuery/useMutation without changing.
 * State resets on reload.
 */

class ApiError extends Error {
  constructor(
    public code: 'NOT_FOUND' | 'INVALID_URL' | 'INVALID_QUANTITY' | 'INVALID_STATE',
    message: string
  ) {
    super(message);
  }
}

let counter = 0;
const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(counter++).toString(36)}`;
const latency = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms));

function buildItem(url: string, quantity: number, extra: Partial<CartItem> = {}): CartItem {
  const match = findByUrl(url);
  if (!match) throw new ApiError('INVALID_URL', `Unknown product URL ${url}`);
  const { entry, offer } = match;
  return {
    id: newId('item'),
    url,
    status: 'active',
    quantity,
    reason: null,
    addedBy: 'app',
    addedAt: Date.now(),
    enrichmentStatus: 'ready',
    product: entry.product,
    variant: entry.variant,
    offer,
    offers: entry.offers,
    rating: entry.rating,
    price: priceFor(offer, quantity),
    priceHistory: historyFor(entry.history[offer.id]),
    ...extra,
  };
}

function priceFor(offer: Offer, quantity: number): NonNullable<CartItem['price']> {
  const subtotalCents = offer.priceCents * quantity;
  const taxCents = Math.round(subtotalCents * TAX_RATE);
  return {
    currentCents: offer.priceCents,
    listPriceCents: offer.listPriceCents,
    currency: offer.currency,
    subtotalCents,
    taxCents,
    shippingCents: offer.shippingCents,
    totalCents: subtotalCents + taxCents + offer.shippingCents,
    estimated: true,
  };
}

function historyFor(points: PricePoint[]): PriceHistory {
  const prices = points.map((p) => p.priceCents);
  return {
    points,
    lowCents: Math.min(...prices),
    highCents: Math.max(...prices),
    currentCents: prices[prices.length - 1],
  };
}

function quoteFor(item: CartItem, offer: Offer, quantity: number): Quote {
  const price = priceFor(offer, quantity);
  return {
    retailer: offer.retailer,
    retailerName: offer.retailerName,
    seller: offer.seller,
    productTitle: item.product?.title ?? item.url,
    variantLabel: offer.variantLabel,
    imageUrl: item.product?.imageUrl ?? null,
    quantity,
    unitPriceCents: offer.priceCents,
    subtotalCents: price.subtotalCents,
    taxCents: price.taxCents,
    shippingCents: price.shippingCents,
    totalCents: price.totalCents,
    currency: offer.currency,
    deliveryEstimate: offer.deliveryEstimate,
    returnSummary: offer.returnSummary,
    quotedAt: Date.now(),
    simulated: true,
  };
}

let items: CartItem[] = [];
const requests = new Map<string, PurchaseRequest>();
const idempotency = new Map<string, string>();
let purchases: Purchase[] = [];

function seedPurchase(offerId: string, orderRef: string, status: ShipmentStatus, orderedDaysAgo: number, etaDays: number) {
  const item = buildItem(offerUrl(offerId), 1, { status: 'purchased', addedAt: daysFromNow(-orderedDaysAgo - 1) });
  const offer = item.offer!;
  const placedAt = daysFromNow(-orderedDaysAgo);
  const quote = quoteFor(item, offer, 1);
  if (status === 'delivered') quote.returnSummary = returnSummaryFor(offer.retailer, daysFromNow(etaDays));
  const requestId = newId('req');
  const orderId = newId('order');
  const shipment = {
    status,
    carrier: status === 'ordered' ? null : 'UPS',
    trackingNumber: status === 'ordered' ? null : `1Z${orderRef.replace(/\W/g, '')}`,
    trackingUrl: null,
    eta: etaFromNow(etaDays),
    updatedAt: Date.now(),
    simulated: true,
  };
  items.push(item);
  purchases.push({
    orderId,
    orderRef,
    requestId,
    itemId: item.id,
    status: 'placed',
    retailerOrderId: orderRef,
    placedAt,
    quote,
    simulated: true,
    shipment,
  });
}

function seed() {
  items = [
    buildItem('https://www.nike.com/t/pegasus-41-FD2722-002', 1, { addedAt: daysFromNow(-2) }),
    buildItem('https://www.bestbuy.com/site/6449913.p', 1, { addedAt: daysFromNow(-1) }),
    buildItem(HERO_URL, 1, { addedAt: Date.now(), addedBy: 'agent', reason: 'Noise cancelling for long flights' }),
  ];
  purchases = [];
  seedPurchase('garmin-forerunner-265@rei', 'CART-8R4E1Q2W0T', 'out_for_delivery', 3, 0);
  seedPurchase('breville-bambino-plus@target', 'CART-5T9X2M7K1B', 'shipped', 2, 3);
  seedPurchase('galaxy-buds3-pro@walmart', 'CART-2W8N6D3F0P', 'delivered', 9, -4);
}
seed();

function requireItem(itemId: string) {
  const item = items.find((i) => i.id === itemId);
  if (!item) throw new ApiError('NOT_FOUND', 'Item not found');
  return item;
}

export async function listItems(): Promise<CartItem[]> {
  await latency();
  return items.filter((i) => i.status === 'active').sort((a, b) => b.addedAt - a.addedAt);
}

export async function getItem({ itemId }: { itemId: string }): Promise<CartItem> {
  await latency();
  return requireItem(itemId);
}

export async function addItem({
  url,
  reason,
  quantity = 1,
  idempotencyKey,
}: {
  url: string;
  variant?: string;
  reason?: string;
  quantity?: number;
  idempotencyKey: string;
}): Promise<{ itemId: string; enrichmentStatus: 'resolving' | 'enriching'; deduplicated: boolean }> {
  await latency();
  const known = idempotency.get(idempotencyKey);
  if (known) return { itemId: known, enrichmentStatus: 'enriching', deduplicated: true };
  const item = buildItem(url, quantity, { reason: reason ?? null });
  items = [...items, item];
  idempotency.set(idempotencyKey, item.id);
  return { itemId: item.id, enrichmentStatus: 'enriching', deduplicated: false };
}

export async function setQuantity({ itemId, quantity }: { itemId: string; quantity: number }): Promise<null> {
  await latency();
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new ApiError('INVALID_QUANTITY', 'Quantity must be between 1 and 10');
  }
  const item = requireItem(itemId);
  items = items.map((i) => (i === item ? { ...i, quantity, price: priceFor(i.offer!, quantity) } : i));
  return null;
}

export async function removeItem({ itemId }: { itemId: string }): Promise<null> {
  await latency();
  requireItem(itemId);
  items = items.filter((i) => i.id !== itemId);
  return null;
}

export async function requestPurchase({
  itemId,
  offerId,
  quantity,
  reason,
  idempotencyKey,
}: {
  itemId: string;
  offerId: string;
  quantity: number;
  reason: string;
  idempotencyKey: string;
}): Promise<Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'expiresAt' | 'quote'>> {
  await latency(400);
  const existing = idempotency.get(idempotencyKey);
  const item = requireItem(itemId);
  if (item.status !== 'active') throw new ApiError('INVALID_STATE', 'Item was already purchased');
  const offer = item.offers.find((o) => o.id === offerId);
  if (!offer) throw new ApiError('NOT_FOUND', 'Offer not found');
  const request: PurchaseRequest = (existing && requests.get(existing)) || {
    requestId: newId('req'),
    itemId,
    offerId,
    status: 'pending_approval',
    requestedBy: 'app',
    reason,
    quantity,
    quoteVersion: 1,
    quote: quoteFor(item, offer, quantity),
    expiresAt: Date.now() + 30 * 60 * 1000,
    decidedAt: null,
    requestedAt: Date.now(),
    error: null,
    order: null,
    shipment: null,
  };
  requests.set(request.requestId, request);
  idempotency.set(idempotencyKey, request.requestId);
  const { requestId, status, quoteVersion, expiresAt, quote } = request;
  return { requestId, status, quoteVersion, expiresAt, quote };
}

export async function decidePurchase({
  requestId,
  quoteVersion,
  decision,
}: {
  requestId: string;
  quoteVersion: number;
  decision: 'approve' | 'defer';
}): Promise<{ outcome: DecideOutcome; request: PurchaseRequest }> {
  await latency(500);
  const request = requests.get(requestId);
  if (!request) throw new ApiError('NOT_FOUND', 'Request not found');
  if (request.order) return { outcome: 'already_approved', request };
  if (quoteVersion !== request.quoteVersion) return { outcome: 'stale_quote', request };
  if (Date.now() > request.expiresAt) return { outcome: 'expired', request: { ...request, status: 'expired' } };
  if (decision === 'defer') {
    const deferred = { ...request, status: 'deferred' as const, decidedAt: Date.now() };
    requests.set(requestId, deferred);
    return { outcome: 'deferred', request: deferred };
  }
  if (request.status !== 'pending_approval') return { outcome: 'invalid_state', request };

  const quote = request.quote!;
  const placedAt = Date.now();
  const orderRef = `CART-${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const approved: PurchaseRequest = {
    ...request,
    status: 'ordered',
    decidedAt: placedAt,
    order: { orderId: newId('order'), orderRef, status: 'placed', retailerOrderId: null, placedAt, simulated: true },
    shipment: {
      status: 'ordered',
      carrier: null,
      trackingNumber: null,
      trackingUrl: null,
      eta: etaFromNow(deliveryDaysFor(quote.retailer)),
      updatedAt: placedAt,
      simulated: true,
    },
  };
  requests.set(requestId, approved);
  items = items.map((i) => (i.id === request.itemId ? { ...i, status: 'purchased' } : i));
  purchases = [
    {
      orderId: approved.order!.orderId,
      orderRef,
      requestId,
      itemId: request.itemId,
      status: 'placed',
      retailerOrderId: null,
      placedAt,
      quote,
      simulated: true,
      shipment: approved.shipment,
    },
    ...purchases,
  ];
  return { outcome: 'approved', request: approved };
}

export async function listPurchases(): Promise<Purchase[]> {
  await latency();
  return [...purchases].sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0));
}

