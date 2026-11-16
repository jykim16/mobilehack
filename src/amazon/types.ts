import type {
  CartItem,
  Currency,
  DecideOutcome,
  Offer,
  Order as BaseOrder,
  Price,
  PriceHistory,
  PricePoint,
  Product,
  Purchase as BasePurchase,
  PurchaseRequest as BasePurchaseRequest,
  Quote,
  Rating,
  Shipment as BaseShipment,
  ShipmentStatus,
} from '@/data/types';

export type {
  CartItem,
  Currency,
  DecideOutcome,
  Offer,
  Price,
  PriceHistory,
  PricePoint,
  Product,
  Quote,
  Rating,
  ShipmentStatus,
};

/**
 * Order lifecycle status including Convex's `'awaiting_client'` state when a live
 * WebKit/Chromium quote (`simulated: false`) is approved for client-side execution.
 */
export type OrderStatus = BaseOrder['status'] | 'awaiting_client';

export interface Order extends Omit<BaseOrder, 'status'> {
  status: OrderStatus;
}

/**
 * USPS-style carrier scan / milestone event, ordered oldest first (`occurredAt` ms).
 * Aligned across `MOBI-1` (`api-contract.md`), `MOBI-5` (`MOBI-15`), and `MOBI-7`.
 */
export interface ShipmentEvent {
  status: string;
  description: string;
  location: string | null;
  occurredAt: number;
}

export interface Shipment extends BaseShipment {
  events: ShipmentEvent[];
}

export interface PurchaseRequest extends Omit<BasePurchaseRequest, 'shipment' | 'order'> {
  order: Order | null;
  shipment: Shipment | null;
}

export interface Purchase extends Omit<BasePurchase, 'shipment' | 'status'> {
  status: OrderStatus;
  shipment: Shipment | null;
}

export type AmazonBrowserEngine = 'webkit' | 'chromium' | 'unsupported';

export type CartRowMutationOperation =
  | 'increment'
  | 'decrement'
  | 'delete'
  | 'save_for_later'
  | 'move_to_cart';

export type DecidePurchaseOutcome =
  | DecideOutcome
  | 'dry_run_halted'
  | 'requires_signin'
  | 'basket_mismatch'
  | 'safety_blocked'
  | 'unknown';

/**
 * Amazon browser session state exposed via `useAmazonSession()`.
 */
export type AmazonSessionStatus = 'connected' | 'signed_out' | 'busy';

export type AmazonAuthChallenge = 'none' | 'signin' | 'mfa' | 'captcha';

export interface ApprovedBasketItem {
  asin: string;
  quantity: number;
}

export interface CheckoutReviewLineItem {
  asin: string | null;
  title: string;
  quantity: number;
}

export interface AmazonSessionCheckResult {
  signedIn: boolean;
  challenge: AmazonAuthChallenge;
  currentUrl: string;
  cartCount: number | null;
  checkedAt: number;
}

export interface ScrapedAmazonCartRow {
  asin: string;
  cartItemId: string | null;
  title: string;
  unitPriceCents: number;
  listPriceCents: number | null;
  quantity: number;
  imageUrl: string | null;
  seller: string;
  deliveryEstimate: string;
  returnSummary: string;
  inStock: boolean;
}

export interface RawScrapedTrackingEvent {
  dateText: string | null;
  timeText: string | null;
  description: string;
  location: string | null;
}

export interface AmazonAddToCartInput {
  asin?: string;
  url?: string;
  quantity?: number;
  variantLabel?: string;
  reason?: string;
}

export interface AmazonAddToCartResult {
  ok: boolean;
  asin: string;
  usedAodFallback: boolean;
  cartCount: number;
  subtotalCents: number;
  addedItem: CartItem | null;
  cartRows: ScrapedAmazonCartRow[];
  syncedAt: number;
  error?: string;
}

export interface AmazonCheckoutQuoteInput {
  asin?: string;
  quantity?: number;
  approvedItems?: ApprovedBasketItem[];
  /** Defaults to `true`. Never clicks final Place Order regardless. */
  dryRun?: boolean;
}

export type CheckoutHaltStage =
  | 'signin_gate'
  | 'captcha_gate'
  | 'checkout_review'
  | 'cart_empty'
  | 'basket_mismatch'
  | 'total_unverified';

export interface AmazonCheckoutQuoteResult {
  ok: boolean;
  dryRun: boolean;
  requiresSignIn: boolean;
  haltedAt: CheckoutHaltStage;
  canPlaceOrder: boolean;
  liveTotalVerified: boolean;
  basketBound: boolean;
  approvedItems: ApprovedBasketItem[];
  quote: Quote | null;
  currentUrl: string;
  quotedAt: number;
  error?: string;
}

export interface AmazonPlaceOrderInput {
  asin?: string;
  quantity?: number;
  approvedItems?: ApprovedBasketItem[];
  orderRef?: string;
  /** Required positive integer cents for live placement (`dryRun === false`). */
  expectedTotalCents?: number;
  /** Optional dollar alias (e.g. 249.00 -> 24900 cents) if caller passes dollars. */
  expectedTotal?: number;
  /**
   * HARD SAFETY GATE: defaults to `true`.
   * Final order submission is blocked unless `dryRun === false && userConfirmed === true`.
   */
  dryRun?: boolean;
  userConfirmed?: boolean;
}

export type PlaceOrderExecutionStatus =
  | 'dry_run_halted'
  | 'placed'
  | 'unknown'
  | 'requires_signin'
  | 'requote_required'
  | 'basket_mismatch'
  | 'safety_blocked'
  | 'failed';

export interface AmazonPlaceOrderResult {
  status: PlaceOrderExecutionStatus;
  safetyGate: {
    dryRun: boolean;
    userConfirmed: boolean;
    orderSubmitted: boolean;
  };
  orderRef: string;
  retailerOrderId: string | null;
  placedAt: number | null;
  quote: Quote | null;
  shipment: Shipment | null;
  reason?: string;
  syncError?: string | null;
}

export interface AmazonSyncOrdersResult {
  ok: boolean;
  requiresSignIn: boolean;
  purchases: Purchase[];
  syncedAt: number;
  error?: string;
  syncError?: string | null;
}

export interface AmazonCheckoutItemInput {
  item: CartItem;
  requestId?: string;
  quoteVersion?: number;
  orderRef?: string;
  /**
   * Defaults to `true`. Live checkout also requires explicit `userConfirmed: true`.
   * Pass `dryRun: true` in automated tests or dry-run quote previews so `#placeYourOrder` is never clicked.
   */
  dryRun?: boolean;
  userConfirmed?: boolean;
}

export interface AmazonSessionHookValue {
  status: AmazonSessionStatus;
  browserEngine: AmazonBrowserEngine;
  shopperId: string | null;
  isSheetOpen: boolean;
  currentUrl: string;
  challenge: AmazonAuthChallenge;
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  pendingSyncCount: number;
  openBrowserSheet: (initialUrl?: string) => void;
  closeBrowserSheet: () => void;
  ensureSignedIn: () => Promise<boolean>;
  resetSession: () => Promise<void>;
  signOut: () => Promise<void>;
  checkSession: () => Promise<AmazonSessionCheckResult>;
  addToCart: (input: AmazonAddToCartInput) => Promise<AmazonAddToCartResult>;
  getCheckoutQuote: (input?: AmazonCheckoutQuoteInput) => Promise<AmazonCheckoutQuoteResult>;
  placeOrder: (input: AmazonPlaceOrderInput) => Promise<AmazonPlaceOrderResult>;
  checkoutAmazonItem: (input: AmazonCheckoutItemInput) => Promise<AmazonPlaceOrderResult>;
  syncOrders: () => Promise<AmazonSyncOrdersResult>;
  flushPendingSync: () => Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }>;
}

/**
 * Adapter contract aligned 1:1 with `src/data/cart-api.ts` and `api-contract.md`.
 */
export interface AmazonCartAdapterValue {
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
  pendingRequests: PurchaseRequest[];
  lastSyncedAt: number | null;
  lastSyncError: string | null;
  pendingSyncCount: number;
  listItems: () => Promise<CartItem[]>;
  getItem: (args: { itemId: string }) => Promise<CartItem | null>;
  addItem: (args: {
    url: string;
    variant?: string;
    reason?: string;
    quantity?: number;
    idempotencyKey: string;
  }) => Promise<{
    itemId: string;
    enrichmentStatus: 'resolving' | 'enriching';
    deduplicated: boolean;
  }>;
  setQuantity: (args: { itemId: string; quantity: number }) => Promise<null>;
  removeItem: (args: { itemId: string }) => Promise<null>;
  listPurchases: () => Promise<Purchase[]>;
  requestPurchase: (args: {
    itemId: string;
    offerId: string;
    quantity: number;
    reason: string;
    idempotencyKey: string;
  }) => Promise<
    Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'expiresAt' | 'quote'>
  >;
  decidePurchase: (args: {
    requestId: string;
    quoteVersion: number;
    decision: 'approve' | 'defer';
    /** HARD SAFETY GATE: defaults to `true`. */
    dryRun?: boolean;
    userConfirmed?: boolean;
  }) => Promise<{
    outcome: DecidePurchaseOutcome;
    request: PurchaseRequest;
    orderResult?: AmazonPlaceOrderResult;
  }>;
  checkoutAmazonItem: (input: AmazonCheckoutItemInput) => Promise<AmazonPlaceOrderResult>;
  refreshCart: () => Promise<CartItem[]>;
  refreshPurchases: () => Promise<Purchase[]>;
  resetSession: () => Promise<void>;
  flushPendingSync: () => Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }>;
}
