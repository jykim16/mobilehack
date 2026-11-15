import { buildShipmentEvents, extractAsin, parseDeliveryEtaIso } from './asin';
import {
  type AttachClientQuoteArgs,
  buildRecordClientPlacementArgs,
  type ConvexAmazonSyncClient,
  type RecordClientPlacementArgs,
  type SyncClientShipmentArgs,
} from './convex-sync';
import {
  OrderSubmissionLedger,
  resolveOrderConfirmationOutcome,
} from './safety';
import type {
  AmazonAddToCartResult,
  AmazonPlaceOrderResult,
  ApprovedBasketItem,
  CartItem,
  Purchase,
  PurchaseRequest,
  Quote,
  ScrapedAmazonCartRow,
  Shipment,
} from './types';

/**
 * Select the cart item matching `expectedAsin` at `>= minQuantity`.
 * Never falls back to an unrelated pre-existing cart row (`items[0]`).
 */
export function selectVerifiedAddedCartItem(
  items: CartItem[],
  expectedAsin: string,
  minQuantity = 1,
): CartItem | null {
  const target = expectedAsin.trim().toUpperCase();
  if (!target) return null;
  const matched = items.find((item) => extractAsin(item.url) === target) ?? null;
  if (!matched) return null;
  if (matched.quantity < minQuantity) return null;
  return matched;
}

/**
 * Execute `addItem` with strict failure propagation before caching `idempotencyKey`.
 * Failed/CAPTCHA/missing-offer attempts never poison `idempotencyMap`.
 */
export async function executeIdempotentAddItem(params: {
  idempotencyMap: Map<string, string>;
  idempotencyKey: string;
  isSessionCurrent?: () => boolean;
  runAddToCart: () => Promise<AmazonAddToCartResult>;
}): Promise<{
  itemId: string;
  enrichmentStatus: 'resolving' | 'enriching';
  deduplicated: boolean;
}> {
  const existingId = params.idempotencyMap.get(params.idempotencyKey);
  if (existingId) {
    return {
      itemId: existingId,
      enrichmentStatus: 'enriching',
      deduplicated: true,
    };
  }

  const res = await params.runAddToCart();
  if (params.isSessionCurrent && !params.isSessionCurrent()) {
    throw new Error('Amazon session was reset before addItem completed.');
  }
  if (!res.ok || !res.addedItem) {
    throw new Error(
      res.error ?? `Failed to add ASIN ${res.asin || 'unknown'} to Amazon cart.`,
    );
  }

  params.idempotencyMap.set(params.idempotencyKey, res.addedItem.id);
  return {
    itemId: res.addedItem.id,
    enrichmentStatus: 'enriching',
    deduplicated: false,
  };
}

export interface LiveQuantityMutationPlan {
  found: boolean;
  clampedTarget: number;
  liveQuantity: number | null;
  operation: 'increment' | 'decrement' | 'none';
  steps: number;
}

/**
 * Compute cart stepper delta strictly from live scraped `/gp/cart/view.html` rows inside
 * the serialized command queue rather than a pre-queue React state snapshot.
 */
export function computeLiveCartQuantityPlan(
  liveRows: ScrapedAmazonCartRow[],
  asin: string,
  requestedQuantity: number,
): LiveQuantityMutationPlan {
  const clampedTarget = Math.max(1, Math.min(10, Math.floor(requestedQuantity)));
  const normalizedAsin = asin.trim().toUpperCase();
  const row = liveRows.find((r) => r.asin.trim().toUpperCase() === normalizedAsin);
  if (!row) {
    return {
      found: false,
      clampedTarget,
      liveQuantity: null,
      operation: 'none',
      steps: 0,
    };
  }

  const delta = clampedTarget - row.quantity;
  if (delta === 0) {
    return {
      found: true,
      clampedTarget,
      liveQuantity: row.quantity,
      operation: 'none',
      steps: 0,
    };
  }

  return {
    found: true,
    clampedTarget,
    liveQuantity: row.quantity,
    operation: delta > 0 ? 'increment' : 'decrement',
    steps: Math.min(9, Math.abs(delta)),
  };
}

export function verifyFinalCartRowQuantity(
  finalRows: ScrapedAmazonCartRow[],
  asin: string,
  expectedQuantity: number,
): { ok: true; row: ScrapedAmazonCartRow } | { ok: false; actualQuantity: number | null; reason: string } {
  const normalizedAsin = asin.trim().toUpperCase();
  const row = finalRows.find((r) => r.asin.trim().toUpperCase() === normalizedAsin);
  if (!row) {
    return {
      ok: false,
      actualQuantity: null,
      reason: `Amazon cart row for ASIN ${normalizedAsin} disappeared during quantity update.`,
    };
  }
  if (row.quantity !== expectedQuantity) {
    return {
      ok: false,
      actualQuantity: row.quantity,
      reason: `Amazon cart quantity for ASIN ${normalizedAsin} settled at ${row.quantity} instead of requested ${expectedQuantity}.`,
    };
  }
  return { ok: true, row };
}

/**
 * Apply reconciled `OrderSubmissionLedger` transitions (`unknown` -> `placed`) onto
 * `pendingRequests`, `purchases`, `items`, and `purchasedItems`, preserving the original
 * `requestId`, `orderId`, `orderRef`, and `itemId` identities.
 */
export function applyLedgerReconciliationsToState(params: {
  reconciled: { orderRef: string; retailerOrderId: string; placedAt: number }[];
  pendingRequests: PurchaseRequest[];
  items: CartItem[];
  purchasedItems: Record<string, CartItem>;
  syncedPurchases: Purchase[];
}): {
  pendingRequests: PurchaseRequest[];
  items: CartItem[];
  purchasedItems: Record<string, CartItem>;
  purchases: Purchase[];
  placementsToSync: RecordClientPlacementArgs[];
} {
  if (params.reconciled.length === 0) {
    return {
      pendingRequests: params.pendingRequests,
      items: params.items,
      purchasedItems: params.purchasedItems,
      purchases: params.syncedPurchases,
      placementsToSync: [],
    };
  }

  const reconciledByRef = new Map(params.reconciled.map((r) => [r.orderRef, r]));
  const syncedByOrderId = new Map<string, Purchase>();
  for (const p of params.syncedPurchases) {
    if (p.retailerOrderId) {
      syncedByOrderId.set(p.retailerOrderId, p);
    }
  }

  const nextPurchasedItems: Record<string, CartItem> = { ...params.purchasedItems };
  const activeById = new Map(params.items.map((item) => [item.id, item]));
  const removedActiveIds = new Set<string>();
  const purchaseOverridesByOrderId = new Map<string, Purchase>();
  const placementsToSync: RecordClientPlacementArgs[] = [];

  const nextPendingRequests = params.pendingRequests.map((req) => {
    const reqOrderRef = req.order?.orderRef ?? `CART-${req.requestId.toUpperCase()}`;
    const match = reconciledByRef.get(reqOrderRef);
    if (!match) return req;

    const syncedPurchase = syncedByOrderId.get(match.retailerOrderId);
    const preservedOrderId = req.order?.orderId ?? `order_${match.placedAt.toString(36)}`;
    const fallbackQuote = req.quote ?? syncedPurchase?.quote;
    const fallbackShipment: Shipment =
      syncedPurchase?.shipment ?? {
        status: 'ordered',
        carrier: null,
        trackingNumber: null,
        trackingUrl: null,
        eta: parseDeliveryEtaIso(fallbackQuote?.deliveryEstimate, match.placedAt),
        events: buildShipmentEvents({
          status: 'ordered',
          headline: 'Order reconciled from Amazon Your Orders',
          placedAt: match.placedAt,
          updatedAt: match.placedAt,
        }),
        updatedAt: match.placedAt,
        simulated: false,
      };

    const activeItem = activeById.get(req.itemId);
    if (activeItem) {
      nextPurchasedItems[req.itemId] = { ...activeItem, status: 'purchased' };
      removedActiveIds.add(req.itemId);
    } else if (syncedPurchase && nextPurchasedItems[syncedPurchase.itemId] && !nextPurchasedItems[req.itemId]) {
      nextPurchasedItems[req.itemId] = {
        ...nextPurchasedItems[syncedPurchase.itemId]!,
        id: req.itemId,
      };
    }

    if (fallbackQuote) {
      purchaseOverridesByOrderId.set(match.retailerOrderId, {
        orderId: preservedOrderId,
        orderRef: reqOrderRef,
        requestId: req.requestId,
        itemId: req.itemId,
        status: 'placed',
        retailerOrderId: match.retailerOrderId,
        placedAt: match.placedAt,
        quote: fallbackQuote,
        simulated: false,
        shipment: fallbackShipment,
      });
    }

    placementsToSync.push(
      buildRecordClientPlacementArgs({
        orderRef: reqOrderRef,
        retailerOrderId: match.retailerOrderId,
        placedAt: match.placedAt,
        shipment: fallbackShipment,
      }),
    );

    return {
      ...req,
      status: 'ordered' as const,
      decidedAt: req.decidedAt ?? match.placedAt,
      order: {
        orderId: preservedOrderId,
        orderRef: reqOrderRef,
        status: 'placed' as const,
        retailerOrderId: match.retailerOrderId,
        placedAt: match.placedAt,
        simulated: false,
      },
      shipment: fallbackShipment,
    };
  });

  const nextPurchases: Purchase[] = [];
  const seenOrderIds = new Set<string>();

  for (const p of params.syncedPurchases) {
    if (p.retailerOrderId && purchaseOverridesByOrderId.has(p.retailerOrderId)) {
      nextPurchases.push(purchaseOverridesByOrderId.get(p.retailerOrderId)!);
      seenOrderIds.add(p.retailerOrderId);
    } else {
      nextPurchases.push(p);
      if (p.retailerOrderId) seenOrderIds.add(p.retailerOrderId);
    }
  }

  for (const [orderId, override] of purchaseOverridesByOrderId.entries()) {
    if (!seenOrderIds.has(orderId)) {
      nextPurchases.unshift(override);
    }
  }

  const nextItems =
    removedActiveIds.size > 0
      ? params.items.filter((item) => !removedActiveIds.has(item.id))
      : params.items;

  return {
    pendingRequests: nextPendingRequests,
    items: nextItems,
    purchasedItems: nextPurchasedItems,
    purchases: nextPurchases,
    placementsToSync,
  };
}

export type PendingConvexSyncJob =
  | { kind: 'quote'; key: string; args: AttachClientQuoteArgs }
  | { kind: 'placement'; key: string; args: RecordClientPlacementArgs }
  | { kind: 'shipment'; key: string; args: SyncClientShipmentArgs };

export interface ConvexSyncQueueSnapshot {
  pendingCount: number;
  lastSyncError: string | null;
}

/**
 * Durable in-memory retry queue for `attachClientQuote`, `recordClientPlacement`, and
 * `syncClientShipment` so transient backend/network errors never silently drop placements,
 * quotes, or shipments, while keeping retailer purchase outcomes separate from sync status.
 */
export class ConvexSyncRetryQueue {
  private readonly jobs = new Map<string, PendingConvexSyncJob>();
  private lastError: string | null = null;
  private generation = 0;
  private activeFlush: Promise<{ synced: number; remaining: number; lastSyncError: string | null }> | null =
    null;
  private readonly onStateChange?: (snapshot: ConvexSyncQueueSnapshot) => void;

  constructor(onStateChange?: (snapshot: ConvexSyncQueueSnapshot) => void) {
    this.onStateChange = onStateChange;
  }

  get pendingCount(): number {
    return this.jobs.size;
  }

  get lastSyncError(): string | null {
    return this.lastError;
  }

  clear(): void {
    this.generation += 1;
    this.jobs.clear();
    this.lastError = null;
    this.activeFlush = null;
    this.emit();
  }

  private emit(): void {
    this.onStateChange?.({
      pendingCount: this.jobs.size,
      lastSyncError: this.lastError,
    });
  }

  enqueueQuote(args: AttachClientQuoteArgs, client?: ConvexAmazonSyncClient): Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }> {
    if (!client?.attachClientQuote) {
      return Promise.resolve({
        synced: 0,
        remaining: this.jobs.size,
        lastSyncError: this.lastError,
      });
    }
    const key = `quote:${args.requestId}:${args.quoteVersion}`;
    this.jobs.set(key, { kind: 'quote', key, args });
    this.emit();
    return this.flush(client);
  }

  enqueuePlacement(args: RecordClientPlacementArgs, client?: ConvexAmazonSyncClient): Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }> {
    if (!client?.recordClientPlacement) {
      return Promise.resolve({
        synced: 0,
        remaining: this.jobs.size,
        lastSyncError: this.lastError,
      });
    }
    const key = `placement:${args.orderRef}`;
    this.jobs.set(key, { kind: 'placement', key, args });
    this.emit();
    return this.flush(client);
  }

  enqueueShipment(args: SyncClientShipmentArgs, client?: ConvexAmazonSyncClient): Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }> {
    if (!client?.syncClientShipment) {
      return Promise.resolve({
        synced: 0,
        remaining: this.jobs.size,
        lastSyncError: this.lastError,
      });
    }
    const key = `shipment:${args.retailerOrderId}`;
    this.jobs.set(key, { kind: 'shipment', key, args });
    this.emit();
    return this.flush(client);
  }

  flush(client?: ConvexAmazonSyncClient): Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }> {
    if (this.activeFlush) {
      return this.activeFlush.then(() =>
        this.jobs.size > 0 && client
          ? this.flush(client)
          : {
              synced: 0,
              remaining: this.jobs.size,
              lastSyncError: this.lastError,
            },
      );
    }

    if (!client || this.jobs.size === 0) {
      return Promise.resolve({
        synced: 0,
        remaining: this.jobs.size,
        lastSyncError: this.lastError,
      });
    }

    const flushGen = this.generation;
    const run = this.runFlush(client, flushGen).finally(() => {
      if (this.activeFlush === run) {
        this.activeFlush = null;
      }
    });
    this.activeFlush = run;
    return run;
  }

  private async runFlush(
    client: ConvexAmazonSyncClient,
    flushGen: number,
  ): Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }> {
    let synced = 0;
    let latestFailure: string | null = null;

    for (const [key, job] of Array.from(this.jobs.entries())) {
      if (this.generation !== flushGen) {
        return {
          synced: 0,
          remaining: this.jobs.size,
          lastSyncError: this.lastError,
        };
      }
      if (this.jobs.get(key) !== job) {
        continue;
      }

      try {
        if (job.kind === 'quote') {
          if (!client.attachClientQuote) continue;
          await client.attachClientQuote(job.args);
        } else if (job.kind === 'placement') {
          if (!client.recordClientPlacement) continue;
          await client.recordClientPlacement(job.args);
        } else {
          if (!client.syncClientShipment) continue;
          await client.syncClientShipment(job.args);
        }

        if (this.generation !== flushGen) {
          return {
            synced: 0,
            remaining: this.jobs.size,
            lastSyncError: this.lastError,
          };
        }
        if (this.jobs.get(key) === job) {
          this.jobs.delete(key);
          synced += 1;
        }
      } catch (err) {
        if (this.generation !== flushGen) {
          return {
            synced: 0,
            remaining: this.jobs.size,
            lastSyncError: this.lastError,
          };
        }
        if (this.jobs.get(key) === job) {
          latestFailure = err instanceof Error ? err.message : String(err);
        }
      }
    }

    if (this.generation !== flushGen) {
      return {
        synced: 0,
        remaining: this.jobs.size,
        lastSyncError: this.lastError,
      };
    }

    if (this.jobs.size === 0) {
      this.lastError = null;
    } else if (latestFailure !== null) {
      this.lastError = latestFailure;
    }

    this.emit();
    return {
      synced,
      remaining: this.jobs.size,
      lastSyncError: this.lastError,
    };
  }
}

/**
 * Settle a submitted checkout order (`submitRes.submitted === true`):
 * 1. Immediately records `unknown` in `OrderSubmissionLedger` with pre-existing order IDs.
 * 2. Catches navigation/step-timeout errors during confirmation scraping and returns a structured
 *    `status: 'unknown'` (`orderSubmitted: true`) result instead of rejecting out of `placeOrder`.
 * 3. On verified confirmation (`###-#######-#######`), records `placed` and enqueues Convex sync
 *    in `ConvexSyncRetryQueue` so transient backend failures are retained and surfaced via `syncError`.
 */
export async function settleSubmittedOrderConfirmation(params: {
  orderRef: string;
  submittedAt: number;
  approvedItems: ApprovedBasketItem[];
  expectedTotalCents: number;
  preExistingOrderIds?: Iterable<string>;
  verifiedQuote: Quote;
  ledger: OrderSubmissionLedger;
  syncQueue: ConvexSyncRetryQueue;
  convexSync?: ConvexAmazonSyncClient;
  isSessionCurrent?: () => boolean;
  readConfirmation: () => Promise<{
    retailerOrderId: string | null;
    isConfirmationSurface?: boolean;
    hasAuthOrErrorBarrier?: boolean;
    currentUrl: string;
  }>;
}): Promise<AmazonPlaceOrderResult> {
  const stillCurrent = () => (params.isSessionCurrent ? params.isSessionCurrent() : true);

  if (stillCurrent()) {
    params.ledger.recordUnknown({
      orderRef: params.orderRef,
      submittedAt: params.submittedAt,
      approvedItems: params.approvedItems,
      expectedTotalCents: params.expectedTotalCents,
      preExistingOrderIds: params.preExistingOrderIds,
    });
  }

  let confirmation: {
    retailerOrderId: string | null;
    isConfirmationSurface?: boolean;
    hasAuthOrErrorBarrier?: boolean;
    currentUrl: string;
  };

  try {
    confirmation = await params.readConfirmation();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: 'unknown',
      safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
      orderRef: params.orderRef,
      retailerOrderId: null,
      placedAt: null,
      quote: params.verifiedQuote,
      shipment: null,
      reason: `Place Order was submitted, but confirmation inspection failed (${detail}). Retained as unknown; reconcile via syncOrders() before retrying.`,
      syncError: stillCurrent() ? params.syncQueue.lastSyncError : null,
    };
  }

  if (!stillCurrent()) {
    return {
      status: 'unknown',
      safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
      orderRef: params.orderRef,
      retailerOrderId: null,
      placedAt: null,
      quote: params.verifiedQuote,
      shipment: null,
      reason:
        'Session was reset after Place Order submission before confirmation settled; avoiding cross-account state or sync writes.',
      syncError: null,
    };
  }

  const resolution = resolveOrderConfirmationOutcome(confirmation);
  if (resolution.status === 'unknown') {
    return {
      status: 'unknown',
      safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
      orderRef: params.orderRef,
      retailerOrderId: null,
      placedAt: null,
      quote: params.verifiedQuote,
      shipment: null,
      reason: resolution.reason,
      syncError: params.syncQueue.lastSyncError,
    };
  }

  const placedAt = Date.now();
  const retailerOrderId = resolution.retailerOrderId;
  const initialShipment: Shipment = {
    status: 'ordered',
    carrier: null,
    trackingNumber: null,
    trackingUrl: null,
    eta: parseDeliveryEtaIso(params.verifiedQuote.deliveryEstimate, placedAt),
    events: buildShipmentEvents({
      status: 'ordered',
      headline: 'Order placed on Amazon',
      placedAt,
      updatedAt: placedAt,
    }),
    updatedAt: placedAt,
    simulated: false,
  };

  params.ledger.recordPlaced(params.orderRef, retailerOrderId, placedAt);

  const syncRes = await params.syncQueue.enqueuePlacement(
    buildRecordClientPlacementArgs({
      orderRef: params.orderRef,
      retailerOrderId,
      placedAt,
      shipment: initialShipment,
    }),
    params.convexSync,
  );

  return {
    status: 'placed',
    safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
    orderRef: params.orderRef,
    retailerOrderId,
    placedAt,
    quote: params.verifiedQuote,
    shipment: initialShipment,
    syncError: syncRes.lastSyncError,
  };
}

/**
 * Decide whether a change in authenticated app `shopperId` must reset the persistent Amazon
 * WebView session, cached orders, cart state, and sync queues.
 *
 * - Switching from a non-empty `prevShopperId` to `null`/`undefined` (sign-out) or to a different
 *   `nextShopperId` (account switch) ALWAYS triggers a full reset.
 * - Hydrating from `null`/`undefined` to a `nextShopperId` triggers a reset only if pre-auth
 *   Amazon session/cart/order state was already present, avoiding redundant sign-out navigations
 *   on clean cold launches.
 */
export function shouldResetAmazonSessionOnShopperChange(params: {
  prevShopperId: string | null | undefined;
  nextShopperId: string | null | undefined;
  hasRetainedSessionData?: boolean;
}): boolean {
  const prev = typeof params.prevShopperId === 'string' ? params.prevShopperId.trim() : '';
  const next = typeof params.nextShopperId === 'string' ? params.nextShopperId.trim() : '';
  if (prev === next) return false;
  if (prev.length > 0) {
    return true;
  }
  return Boolean(params.hasRetainedSessionData && next.length > 0);
}

export interface ResettableAmazonStores<TCacheValue = unknown> {
  ledger: OrderSubmissionLedger;
  syncQueue: ConvexSyncRetryQueue;
  idempotencyMap: Map<string, string>;
  productCache: Map<string, TCacheValue>;
}

/**
 * Synchronously wipe all in-memory idempotency, ledger, product metadata, and Convex retry stores
 * during `resetSession()` / shopper sign-out and return a clean empty state snapshot.
 */
export function resetAmazonSessionStores<TCacheValue = unknown>(
  stores: ResettableAmazonStores<TCacheValue>,
): {
  isSignedIn: false;
  challenge: 'none';
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
  pendingRequests: PurchaseRequest[];
  lastSyncedAt: null;
  lastSyncError: null;
  pendingSyncCount: 0;
} {
  stores.ledger.clear();
  stores.syncQueue.clear();
  stores.idempotencyMap.clear();
  stores.productCache.clear();

  return {
    isSignedIn: false,
    challenge: 'none',
    items: [],
    purchases: [],
    purchasedItems: {},
    pendingRequests: [],
    lastSyncedAt: null,
    lastSyncError: null,
    pendingSyncCount: 0,
  };
}

/**
 * Epoch + fail-closed logout barrier that fences all asynchronous WebView continuations
 * and refuses new shopper operations until Amazon's server-side sign-out (`HttpOnly` cookies)
 * is positively verified (`signedIn === false` on an `amazon.com` origin).
 */
export class SessionResetBarrier {
  private currentEpoch = 0;
  private logoutRequired = false;

  get epoch(): number {
    return this.currentEpoch;
  }

  get isLogoutPending(): boolean {
    return this.logoutRequired;
  }

  beginReset(options: { requiresBrowserSignOut: boolean }): number {
    this.currentEpoch += 1;
    if (options.requiresBrowserSignOut) {
      this.logoutRequired = true;
    }
    return this.currentEpoch;
  }

  isCurrent(capturedEpoch: number): boolean {
    return this.currentEpoch === capturedEpoch && !this.logoutRequired;
  }

  verifySignOutResult(
    resetEpoch: number,
    probe: { currentUrl?: string | null; signedIn?: boolean | null } | null | undefined,
  ): { ok: true } | { ok: false; reason: string } {
    if (this.currentEpoch !== resetEpoch) {
      return {
        ok: false,
        reason: 'Superseded by a newer Amazon session reset.',
      };
    }

    const url = typeof probe?.currentUrl === 'string' ? probe.currentUrl : '';
    const onAmazonOrigin = /^https:\/\/([a-z0-9-]+\.)?amazon\.com(\/|$)/i.test(url);
    if (!onAmazonOrigin) {
      this.logoutRequired = true;
      return {
        ok: false,
        reason:
          'Amazon sign-out could not be verified (browser did not reach amazon.com). Session remains locked until sign-out succeeds.',
      };
    }

    if (probe?.signedIn !== false) {
      this.logoutRequired = true;
      return {
        ok: false,
        reason:
          'Amazon session still appeared signed in after sign-out navigation. Session remains locked until sign-out succeeds.',
      };
    }

    this.logoutRequired = false;
    return { ok: true };
  }
}
