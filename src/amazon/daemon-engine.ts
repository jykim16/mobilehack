import { AMAZON_CART_URL, buildShipmentEvents, extractAsin, parseDeliveryEtaIso } from './asin';
import {
  type AttachClientQuoteArgs,
  buildAttachClientQuoteArgs,
  buildRecordClientPlacementArgs,
  buildSyncClientShipmentArgs,
  type ConvexAmazonSyncClient,
} from './convex-sync';
import {
  computeLiveCartQuantityPlan,
  ConvexSyncRetryQueue,
  settleSubmittedOrderConfirmation,
} from './reconcile-sync';
import {
  AMAZON_ORDER_ID_RE,
  evaluatePreSubmitSafetyGate,
  isValidPositiveCents,
  normalizeApprovedItems,
  OrderSubmissionLedger,
  verifyActiveBasketBinding,
  verifyCheckoutReviewBinding,
} from './safety';
import type {
  AmazonAddToCartInput,
  AmazonAddToCartResult,
  AmazonAuthChallenge,
  AmazonBrowserEngine,
  AmazonCheckoutItemInput,
  AmazonCheckoutQuoteResult,
  AmazonPlaceOrderResult,
  ApprovedBasketItem,
  CartItem,
  CheckoutReviewLineItem,
  DecideOutcome,
  PlaceOrderExecutionStatus,
  Purchase,
  PurchaseRequest,
  Quote,
  ScrapedAmazonCartRow,
  Shipment,
} from './types';

export const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/**
 * Android Chromium / Blink User-Agent intentionally omits `; wv` so Amazon/Passkey/OAuth
 * flows treat the persistent WebView as mobile Chrome on Blink rather than a restricted WebView,
 * while never sending an iPhone Safari UA from a Chromium engine.
 */
export const ANDROID_CHROME_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';

export const HEARTBEAT_INTERVAL_MS = 60_000;
export const DAEMON_POLL_INTERVAL_MS = 2_500;
export const ORDER_SYNC_INTERVAL_MS = 30_000;
export const DEFAULT_SYNC_FAILURE_COOLDOWN_MS = 15_000;

const ESTIMATED_TAX_RATE = 0.0825;
const MAX_LEDGER_ENTRIES = 40;

export function selectBrowserEngine(platformOs: string): AmazonBrowserEngine {
  const normalized = typeof platformOs === 'string' ? platformOs.trim().toLowerCase() : '';
  if (normalized === 'ios') return 'webkit';
  if (normalized === 'android') return 'chromium';
  return 'unsupported';
}

export function selectBrowserUserAgent(platformOs: string): string | undefined {
  const engine = selectBrowserEngine(platformOs);
  if (engine === 'webkit') return IPHONE_SAFARI_USER_AGENT;
  if (engine === 'chromium') return ANDROID_CHROME_USER_AGENT;
  return undefined;
}

export function isInteractiveAuthOrCheckoutUrl(
  url: string,
  challenge: AmazonAuthChallenge = 'none',
): boolean {
  if (challenge !== 'none') return true;
  const current = (url || '').toLowerCase();
  return (
    current.includes('/ap/') ||
    current.includes('/ax/') ||
    current.includes('/errors/validatecaptcha') ||
    current.includes('/gp/buy/') ||
    current.includes('/checkout/')
  );
}

/**
 * Decide whether the 60s background session keep-alive (`checkSession()`) should fire.
 * Never disrupts active queued commands, open browser sheets, `/ap/*` login challenges,
 * or active SPC checkout screens.
 */
export function shouldRunIdleHeartbeat(params: {
  appState: string | null | undefined;
  busyCount: number;
  isSheetOpen: boolean;
  isResetting?: boolean;
  currentUrl: string;
  challenge: AmazonAuthChallenge;
  lastHeartbeatAt: number;
  now: number;
  minIntervalMs?: number;
  forceOnForeground?: boolean;
}): boolean {
  if (params.appState && params.appState !== 'active') return false;
  if (params.isResetting) return false;
  if (params.busyCount > 0) return false;
  if (params.isSheetOpen) return false;
  if (isInteractiveAuthOrCheckoutUrl(params.currentUrl, params.challenge)) return false;

  const minInterval = params.minIntervalMs ?? HEARTBEAT_INTERVAL_MS;
  const threshold = params.forceOnForeground ? Math.min(10_000, minInterval) : minInterval;
  return params.now - params.lastHeartbeatAt >= threshold;
}

export interface KeyValueStorageAdapter {
  getItem: (key: string) => Promise<string | null> | string | null;
  setItem: (key: string, value: string) => Promise<void> | void;
  removeItem: (key: string) => Promise<void> | void;
}

export class InMemoryKeyValueStorage implements KeyValueStorageAdapter {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

export function sanitizeSecureStoreKey(rawShopperId?: string | null): string {
  const cleaned = (rawShopperId ?? 'default')
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 64);
  return `cart_amz_ledger_v1_${cleaned || 'default'}`;
}

export interface SyncedCartLedgerEntry {
  asin: string;
  quantity: number;
  signedIn: boolean;
  syncedAt: number;
}

interface CompactPersistedLedgerPayload {
  v: 1;
  items: Record<string, { a: string; q: number; s: 0 | 1; t: number }>;
}

/**
 * Durable per-shopper synced-cart ledger mapping `cartItemId -> { asin, quantity, signedIn, syncedAt }`.
 * Uses `expo-secure-store` (or any `KeyValueStorageAdapter`) with automatic in-memory fallback so
 * Expo Go, web, and unit tests never throw on storage errors or payload limits.
 */
export class SyncedCartLedger {
  private readonly primaryStorage: KeyValueStorageAdapter;
  private readonly fallbackStorage = new InMemoryKeyValueStorage();
  private shopperKey: string;
  private map = new Map<string, SyncedCartLedgerEntry>();
  private failureMap = new Map<
    string,
    { quantity: number; signedIn: boolean; failedAt: number }
  >();
  private hydratedForKey: string | null = null;

  constructor(storage?: KeyValueStorageAdapter, shopperId?: string | null) {
    this.primaryStorage = storage ?? this.fallbackStorage;
    this.shopperKey = sanitizeSecureStoreKey(shopperId);
  }

  get storageKey(): string {
    return this.shopperKey;
  }

  get isHydrated(): boolean {
    return this.hydratedForKey === this.shopperKey;
  }

  async hydrate(shopperId?: string | null): Promise<void> {
    const nextKey =
      shopperId !== undefined ? sanitizeSecureStoreKey(shopperId) : this.shopperKey;
    if (this.hydratedForKey === nextKey) return;

    this.shopperKey = nextKey;
    this.map.clear();
    this.failureMap.clear();

    let raw: string | null = null;
    try {
      raw = await this.primaryStorage.getItem(nextKey);
    } catch {
      raw = this.fallbackStorage.getItem(nextKey);
    }
    if (raw === null) {
      raw = this.fallbackStorage.getItem(nextKey);
    }

    if (raw) {
      try {
        const parsed = JSON.parse(raw) as Partial<CompactPersistedLedgerPayload>;
        if (parsed && parsed.v === 1 && parsed.items && typeof parsed.items === 'object') {
          for (const [itemId, entry] of Object.entries(parsed.items)) {
            if (
              entry &&
              typeof entry.a === 'string' &&
              typeof entry.q === 'number' &&
              Number.isInteger(entry.q) &&
              entry.q >= 1
            ) {
              this.map.set(itemId, {
                asin: entry.a.toUpperCase(),
                quantity: entry.q,
                signedIn: entry.s === 1,
                syncedAt: typeof entry.t === 'number' ? entry.t : 0,
              });
            }
          }
        }
      } catch {
        // Ignore corrupted payload and start clean
      }
    }

    this.hydratedForKey = nextKey;
  }

  get(cartItemId: string): SyncedCartLedgerEntry | undefined {
    return this.map.get(cartItemId);
  }

  entries(): Record<string, SyncedCartLedgerEntry> {
    return Object.fromEntries(this.map.entries());
  }

  async recordSynced(cartItemId: string, entry: SyncedCartLedgerEntry): Promise<void> {
    this.map.set(cartItemId, {
      asin: entry.asin.trim().toUpperCase(),
      quantity: entry.quantity,
      signedIn: entry.signedIn,
      syncedAt: entry.syncedAt,
    });
    this.failureMap.delete(cartItemId);
    this.trimToCap();
    await this.persist();
  }

  async remove(cartItemId: string): Promise<void> {
    const deleted = this.map.delete(cartItemId);
    this.failureMap.delete(cartItemId);
    if (deleted) {
      await this.persist();
    }
  }

  recordFailure(
    cartItemId: string,
    quantity: number,
    signedIn: boolean,
    failedAt: number,
  ): void {
    this.failureMap.set(cartItemId, { quantity, signedIn, failedAt });
  }

  isCoolingDown(
    cartItemId: string,
    quantity: number,
    signedIn: boolean,
    now: number,
    cooldownMs = DEFAULT_SYNC_FAILURE_COOLDOWN_MS,
  ): boolean {
    const fail = this.failureMap.get(cartItemId);
    if (!fail) return false;
    // Immediately clear failure backoff if quantity changed or shopper signed in
    if (fail.quantity !== quantity || fail.signedIn !== signedIn) {
      this.failureMap.delete(cartItemId);
      return false;
    }
    return now - fail.failedAt < cooldownMs;
  }

  async reset(nextShopperId?: string | null): Promise<void> {
    const prevKey = this.shopperKey;
    this.map.clear();
    this.failureMap.clear();
    this.fallbackStorage.removeItem(prevKey);
    try {
      await this.primaryStorage.removeItem(prevKey);
    } catch {
      // Ignore native SecureStore removal failure
    }
    if (nextShopperId !== undefined) {
      this.shopperKey = sanitizeSecureStoreKey(nextShopperId);
    }
    this.hydratedForKey = this.shopperKey;
  }

  private trimToCap(): void {
    if (this.map.size <= MAX_LEDGER_ENTRIES) return;
    const sorted = Array.from(this.map.entries()).sort(
      (a, b) => a[1].syncedAt - b[1].syncedAt,
    );
    const excess = sorted.length - MAX_LEDGER_ENTRIES;
    for (let i = 0; i < excess; i += 1) {
      const oldestKey = sorted[i]?.[0];
      if (oldestKey) this.map.delete(oldestKey);
    }
  }

  private async persist(): Promise<void> {
    const compactItems: CompactPersistedLedgerPayload['items'] = {};
    for (const [id, entry] of this.map.entries()) {
      compactItems[id] = {
        a: entry.asin,
        q: entry.quantity,
        s: entry.signedIn ? 1 : 0,
        t: entry.syncedAt,
      };
    }
    const serialized = JSON.stringify({ v: 1, items: compactItems } satisfies CompactPersistedLedgerPayload);
    this.fallbackStorage.setItem(this.shopperKey, serialized);
    try {
      await this.primaryStorage.setItem(this.shopperKey, serialized);
    } catch {
      // Retained in fallbackStorage when SecureStore rejects large/unavailable writes
    }
  }
}

export function extractAmazonItemAsin(item: Pick<CartItem, 'url' | 'offer'>): string | null {
  return extractAsin(item.offer?.url) ?? extractAsin(item.url);
}

export interface PlannedCartSyncAction {
  kind: 'add_item' | 'update_quantity' | 'resync_on_signin';
  item: CartItem;
  asin: string;
  targetQuantity: number;
}

/**
 * Compute deterministic cart mutations needed to bring the background WebView's real
 * `amazon.com` cart into alignment with Convex `api.cart.listItems`, prioritizing Muse MCP
 * agent triggers (`addedBy === 'agent'`) first.
 */
export function planConvexCartSyncActions(params: {
  activeItems: CartItem[];
  ledger: SyncedCartLedger;
  isSignedIn: boolean;
  now: number;
  failureCooldownMs?: number;
}): PlannedCartSyncAction[] {
  const candidates: PlannedCartSyncAction[] = [];

  for (const item of params.activeItems) {
    if (item.status !== 'active') continue;
    const asin = extractAmazonItemAsin(item);
    if (!asin) continue;
    const targetQuantity = Math.max(1, Math.min(10, Math.floor(item.quantity || 1)));

    if (
      params.ledger.isCoolingDown(
        item.id,
        targetQuantity,
        params.isSignedIn,
        params.now,
        params.failureCooldownMs,
      )
    ) {
      continue;
    }

    const existing = params.ledger.get(item.id);
    if (!existing) {
      candidates.push({
        kind: 'add_item',
        item,
        asin,
        targetQuantity,
      });
      continue;
    }

    if (existing.asin !== asin) {
      candidates.push({
        kind: 'add_item',
        item,
        asin,
        targetQuantity,
      });
      continue;
    }

    if (params.isSignedIn && !existing.signedIn) {
      candidates.push({
        kind: 'resync_on_signin',
        item,
        asin,
        targetQuantity,
      });
      continue;
    }

    if (existing.quantity !== targetQuantity) {
      candidates.push({
        kind: 'update_quantity',
        item,
        asin,
        targetQuantity,
      });
    }
  }

  // Prioritize Muse MCP triggers (`addedBy === 'agent'`) ahead of ordinary items, then newest first
  candidates.sort((a, b) => {
    const aAgent = a.item.addedBy === 'agent' ? 0 : 1;
    const bAgent = b.item.addedBy === 'agent' ? 0 : 1;
    if (aAgent !== bAgent) return aAgent - bAgent;
    return (b.item.addedAt ?? 0) - (a.item.addedAt ?? 0);
  });

  return candidates;
}

/**
/**
 * Execute planned cart sync actions deterministically against the background browser.
 * For BOTH `'resync_on_signin'` AND missing-ledger `'add_item'` actions (including retries
 * after a lost response or items pre-existing in `/gp/cart/view.html`), inspects the live
 * active Amazon cart first so already-present ASINs reconcile to `targetQuantity` rather
 * than clicking `#add-to-cart-button` again and over-incrementing the basket!
 */
export async function executeCartSyncPlan(params: {
  actions: PlannedCartSyncAction[];
  ledger: SyncedCartLedger;
  isSignedIn: boolean;
  now?: () => number;
  shouldAbort?: () => boolean;
  addToCart: (input: AmazonAddToCartInput) => Promise<AmazonAddToCartResult>;
  setQuantity: (args: { itemId: string; quantity: number }) => Promise<null>;
  refreshCart: () => Promise<CartItem[]>;
}): Promise<{ synced: number; failed: number }> {
  if (params.actions.length === 0) return { synced: 0, failed: 0 };

  const clock = params.now ?? Date.now;
  let synced = 0;
  let failed = 0;
  const liveCache: { byAsin: Map<string, number> | null } = { byAsin: null };

  const ensureLiveByAsin = async (): Promise<Map<string, number>> => {
    if (liveCache.byAsin) return liveCache.byAsin;
    const liveItems = await params.refreshCart();
    const nextMap = new Map<string, number>();
    for (const li of liveItems) {
      const liAsin = extractAsin(li.url);
      if (liAsin) {
        nextMap.set(liAsin, (nextMap.get(liAsin) ?? 0) + li.quantity);
      }
    }
    liveCache.byAsin = nextMap;
    return nextMap;
  };

  for (const action of params.actions) {
    if (params.shouldAbort?.()) break;
    const ts = clock();

    try {
      if (action.kind === 'update_quantity') {
        try {
          await params.setQuantity({
            itemId: action.asin,
            quantity: action.targetQuantity,
          });
          liveCache.byAsin?.set(action.asin, action.targetQuantity);
          await params.ledger.recordSynced(action.item.id, {
            asin: action.asin,
            quantity: action.targetQuantity,
            signedIn: params.isSignedIn,
            syncedAt: clock(),
          });
          synced += 1;
          continue;
        } catch {
          // Row may have been cleared from Amazon cart externally; fall through to live inspection + add
          liveCache.byAsin = null;
        }
      }

      // Inspect live `/gp/cart/view.html` rows before any additive `addToCart` (`resync_on_signin` AND `add_item`)
      const liveByAsin = await ensureLiveByAsin();
      const liveQty = liveByAsin.get(action.asin) ?? 0;

      if (liveQty === action.targetQuantity) {
        await params.ledger.recordSynced(action.item.id, {
          asin: action.asin,
          quantity: action.targetQuantity,
          signedIn: params.isSignedIn,
          syncedAt: ts,
        });
        synced += 1;
        continue;
      }

      if (liveQty > 0) {
        await params.setQuantity({
          itemId: action.asin,
          quantity: action.targetQuantity,
        });
        liveByAsin.set(action.asin, action.targetQuantity);
        await params.ledger.recordSynced(action.item.id, {
          asin: action.asin,
          quantity: action.targetQuantity,
          signedIn: params.isSignedIn,
          syncedAt: clock(),
        });
        synced += 1;
        continue;
      }

      const addRes = await params.addToCart({
        asin: action.asin,
        url: action.item.url,
        quantity: action.targetQuantity,
        variantLabel: action.item.variant?.label ?? undefined,
        reason: action.item.reason ?? undefined,
      });
      if (!addRes.ok) {
        params.ledger.recordFailure(action.item.id, action.targetQuantity, params.isSignedIn, clock());
        failed += 1;
        continue;
      }

      const observedPostAddQty = addRes.addedItem?.quantity ?? action.targetQuantity;
      if (observedPostAddQty !== action.targetQuantity) {
        await params.setQuantity({
          itemId: action.asin,
          quantity: action.targetQuantity,
        });
      }
      liveByAsin.set(action.asin, action.targetQuantity);

      await params.ledger.recordSynced(action.item.id, {
        asin: action.asin,
        quantity: action.targetQuantity,
        signedIn: params.isSignedIn,
        syncedAt: addRes.syncedAt || clock(),
      });
      synced += 1;
    } catch {
      params.ledger.recordFailure(action.item.id, action.targetQuantity, params.isSignedIn, clock());
      failed += 1;
    }
  }

  return { synced, failed };
}

export interface PlannedPendingQuoteAction {
  requestId: string;
  quoteVersion: number;
  itemId: string;
  asin: string;
  url: string;
  quantity: number;
}

export function planPendingApprovalQuotes(params: {
  pendingApprovals: Pick<
    PurchaseRequest,
    'requestId' | 'itemId' | 'status' | 'quantity' | 'quoteVersion' | 'quote' | 'expiresAt'
  >[];
  activeItems: CartItem[];
  isSignedIn: boolean;
  now: number;
  attemptedQuoteMap: Map<string, number>;
  cooldownMs?: number;
}): PlannedPendingQuoteAction[] {
  if (!params.isSignedIn) return [];

  const cooldown = params.cooldownMs ?? DEFAULT_SYNC_FAILURE_COOLDOWN_MS;
  const itemById = new Map(params.activeItems.map((item) => [item.id, item]));
  const planned: PlannedPendingQuoteAction[] = [];

  for (const req of params.pendingApprovals) {
    if (req.status !== 'quoting' && req.status !== 'pending_approval') continue;
    if (req.quote?.simulated === false) continue;
    if (typeof req.expiresAt === 'number' && req.expiresAt <= params.now) continue;

    const item = itemById.get(req.itemId);
    const asin = item ? extractAmazonItemAsin(item) : null;
    if (!item || !asin) continue;

    const attemptKey = `${req.requestId}:${req.quoteVersion}`;
    const lastAttemptAt = params.attemptedQuoteMap.get(attemptKey);
    if (typeof lastAttemptAt === 'number' && params.now - lastAttemptAt < cooldown) {
      continue;
    }

    planned.push({
      requestId: req.requestId,
      quoteVersion: req.quoteVersion,
      itemId: req.itemId,
      asin,
      url: item.url,
      quantity: Math.max(1, Math.min(10, Math.floor(req.quantity || 1))),
    });
  }

  return planned;
}

export function hasActiveUndeliveredAmazonOrders(purchases: Purchase[]): boolean {
  return purchases.some((p) => {
    const isAmazon =
      p.quote?.retailer === 'amazon' ||
      (typeof p.retailerOrderId === 'string' && AMAZON_ORDER_ID_RE.test(p.retailerOrderId));
    if (!isAmazon) return false;
    if (p.status === 'failed') return false;
    if (p.shipment?.status === 'delivered') return false;
    return true;
  });
}

export function shouldPollOrderDeliverySync(params: {
  isSignedIn: boolean;
  hasUndeliveredOrders: boolean;
  lastOrderSyncAt: number;
  now: number;
  intervalMs?: number;
}): boolean {
  if (!params.isSignedIn || !params.hasUndeliveredOrders) return false;
  const interval = params.intervalMs ?? ORDER_SYNC_INTERVAL_MS;
  return params.now - params.lastOrderSyncAt >= interval;
}

/**
 * Coalescing single-flight async runner so overlapping 2500ms interval ticks,
 * Convex `useQuery` reactive updates, and `AppState -> active` transitions never race.
 */
export class SerializedAsyncRunner {
  private activePromise: Promise<void> | null = null;
  private rerunRequested = false;

  get isRunning(): boolean {
    return this.activePromise !== null;
  }

  trigger(task: () => Promise<void>): Promise<void> {
    if (this.activePromise) {
      this.rerunRequested = true;
      return this.activePromise;
    }

    const executeLoop = async () => {
      do {
        this.rerunRequested = false;
        try {
          await task();
        } catch {
          // Individual tick errors are isolated so the daemon stays alive
        }
      } while (this.rerunRequested);
    };

    const run = executeLoop().finally(() => {
      this.activePromise = null;
    });
    this.activePromise = run;
    return run;
  }
}

export interface CartSnapshotScrape {
  signedIn: boolean;
  challenge: AmazonAuthChallenge;
  currentUrl: string;
  cartCount: number;
  subtotalCents: number;
  items: ScrapedAmazonCartRow[];
}

export interface SingleItemIsolationDeps {
  asin: string;
  url: string;
  quantity: number;
  variantLabel?: string | null;
  navigateToCart: () => Promise<void>;
  scrapeCart: () => Promise<CartSnapshotScrape>;
  moveSavedToCart: (asin: string) => Promise<{ mutated: boolean; reason?: string }>;
  addTargetToCart: (input: AmazonAddToCartInput) => Promise<AmazonAddToCartResult>;
  stepRowQuantity: (
    asin: string,
    operation: 'increment' | 'decrement',
  ) => Promise<{ mutated: boolean; reason?: string }>;
  saveRowForLater: (asin: string) => Promise<{ mutated: boolean; reason?: string }>;
  waitMs?: (ms: number) => Promise<void>;
}

export type SingleItemIsolationOutcome =
  | {
      ok: true;
      cartSnap: CartSnapshotScrape;
      matchedRows: ScrapedAmazonCartRow[];
      savedForLaterAsins: string[];
    }
  | {
      ok: false;
      status: 'requires_signin' | 'basket_mismatch' | 'safety_blocked' | 'failed';
      reason: string;
      cartSnap: CartSnapshotScrape | null;
      savedForLaterAsins: string[];
    };

/**
 * Deterministically isolate a single target `{ asin, quantity }` inside `/gp/cart/view.html`:
 * 1. Navigates to `/gp/cart/view.html` and verifies active rows.
 * 2. Restores from `#sc-saved-cart` (`Move to Cart`) or adds via `/dp/<ASIN>` if missing.
 * 3. Steps quantity (`increment`/`decrement`) to match `quantity`.
 * 4. Clicks `Save for later` (`input[data-action="save-for-later"]` / `input[name^="submit.save-for-later."]`)
 *    on EVERY non-target active `.sc-list-item[data-asin]` row so nothing is deleted and ONLY
 *    `{ asin, quantity }` remains in the active cart.
 * 5. Reloads `/gp/cart/view.html`, re-scrapes, and enforces `verifyActiveBasketBinding`
 *    (failing closed with `basket_mismatch` if any extra active item remains!).
 */
export async function isolateSingleActiveCartItem(
  deps: SingleItemIsolationDeps,
): Promise<SingleItemIsolationOutcome> {
  const normalized = normalizeApprovedItems({ asin: deps.asin, quantity: deps.quantity });
  if (!normalized.ok) {
    return {
      ok: false,
      status: 'safety_blocked',
      reason: normalized.reason,
      cartSnap: null,
      savedForLaterAsins: [],
    };
  }

  const targetAsin = normalized.items[0]!.asin;
  const targetQty = normalized.items[0]!.quantity;
  const pause = deps.waitMs ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const savedForLaterAsins: string[] = [];

  await deps.navigateToCart();
  let cartSnap = await deps.scrapeCart();

  if (cartSnap.challenge === 'captcha' || cartSnap.challenge === 'signin' || cartSnap.challenge === 'mfa') {
    return {
      ok: false,
      status: 'requires_signin',
      reason: `Amazon requested ${cartSnap.challenge} verification on /gp/cart/view.html.`,
      cartSnap,
      savedForLaterAsins,
    };
  }

  let mutatedDom = false;
  const hasTargetInActive = cartSnap.items.some(
    (r) => r.asin.trim().toUpperCase() === targetAsin,
  );

  if (!hasTargetInActive) {
    const moved = await deps.moveSavedToCart(targetAsin);
    if (moved.mutated) {
      mutatedDom = true;
      await pause(1200);
      await deps.navigateToCart();
      cartSnap = await deps.scrapeCart();
    }

    const nowInActive = cartSnap.items.some(
      (r) => r.asin.trim().toUpperCase() === targetAsin,
    );
    if (!nowInActive) {
      const addRes = await deps.addTargetToCart({
        asin: targetAsin,
        url: deps.url,
        quantity: targetQty,
        variantLabel: deps.variantLabel ?? undefined,
      });
      if (!addRes.ok) {
        const isChallenge = Boolean(addRes.error && /captcha|sign/i.test(addRes.error));
        return {
          ok: false,
          status: isChallenge ? 'requires_signin' : 'failed',
          reason:
            addRes.error ??
            `Could not add target ASIN ${targetAsin} to active Amazon cart before checkout.`,
          cartSnap: null,
          savedForLaterAsins,
        };
      }
      await deps.navigateToCart();
      cartSnap = await deps.scrapeCart();
      mutatedDom = false;
    }
  }

  // Ensure target row quantity matches `targetQty`
  const qtyPlan = computeLiveCartQuantityPlan(cartSnap.items, targetAsin, targetQty);
  if (!qtyPlan.found) {
    return {
      ok: false,
      status: 'basket_mismatch',
      reason: `Fail-closed: target ASIN ${targetAsin} is missing from /gp/cart/view.html after add/restore.`,
      cartSnap,
      savedForLaterAsins,
    };
  }

  if (qtyPlan.operation !== 'none' && qtyPlan.steps > 0) {
    for (let i = 0; i < qtyPlan.steps; i += 1) {
      const stepRes = await deps.stepRowQuantity(targetAsin, qtyPlan.operation);
      if (!stepRes.mutated) {
        return {
          ok: false,
          status: 'basket_mismatch',
          reason: `Fail-closed: could not ${qtyPlan.operation} quantity for ASIN ${targetAsin} (${stepRes.reason ?? 'control_not_found'}).`,
          cartSnap,
          savedForLaterAsins,
        };
      }
      mutatedDom = true;
      await pause(1000);
    }
  }

  // Click `Save for later` on every non-target active row so nothing is deleted and ONLY target remains
  const nonTargetRows = cartSnap.items.filter(
    (r) => r.asin.trim().toUpperCase() !== targetAsin,
  );
  for (const extraRow of nonTargetRows) {
    const extraAsin = extraRow.asin.trim().toUpperCase();
    const saveRes = await deps.saveRowForLater(extraAsin);
    if (!saveRes.mutated) {
      return {
        ok: false,
        status: 'basket_mismatch',
        reason: `Fail-closed: could not move non-target active cart item ${extraAsin} to Save for later (${saveRes.reason ?? 'control_not_found'}).`,
        cartSnap,
        savedForLaterAsins,
      };
    }
    savedForLaterAsins.push(extraAsin);
    mutatedDom = true;
    await pause(1100);
  }

  if (mutatedDom) {
    await deps.navigateToCart();
    cartSnap = await deps.scrapeCart();
  }

  const basketCheck = verifyActiveBasketBinding(cartSnap.items, {
    asin: targetAsin,
    quantity: targetQty,
    navCartCount: cartSnap.cartCount,
  });

  if (!basketCheck.ok) {
    return {
      ok: false,
      status: 'basket_mismatch',
      reason: basketCheck.reason,
      cartSnap,
      savedForLaterAsins,
    };
  }

  return {
    ok: true,
    cartSnap,
    matchedRows: basketCheck.matchedRows,
    savedForLaterAsins,
  };
}

export interface ConvexCheckoutCoordinator {
  findPendingApprovalForItem?: (itemId: string) => Promise<PurchaseRequest | null>;
  findExistingOrderForItem?: (itemId: string) => Promise<Purchase | null>;
  requestPurchase: (args: {
    itemId: string;
    offerId: string;
    quantity: number;
    reason: string;
    idempotencyKey: string;
  }) => Promise<{
    requestId: string;
    status: PurchaseRequest['status'];
    quoteVersion: number;
    expiresAt: number;
    quote: Quote | null;
  }>;
  getPurchaseStatus?: (args: { requestId: string }) => Promise<PurchaseRequest>;
  attachClientQuote: (args: AttachClientQuoteArgs) => Promise<{
    quoteVersion: number;
    quote: Quote;
  }>;
  decidePurchase: (args: {
    requestId: string;
    quoteVersion: number;
    decision: 'approve' | 'defer';
  }) => Promise<{
    outcome: DecideOutcome;
    request: PurchaseRequest;
  }>;
}

export type ConvexCoordinationOutcome =
  | {
      ok: true;
      orderRef: string;
      requestId: string;
      quoteVersion: number;
      alreadyPlacedOrderId: string | null;
      alreadyPlacedAt: number | null;
    }
  | {
      ok: false;
      status: Exclude<PlaceOrderExecutionStatus, 'placed' | 'unknown' | 'dry_run_halted'>;
      reason: string;
    };

/**
 * Execute the exact Convex purchase coordination sequence (`MOBI-1` contract):
 * 1. `requestPurchase` (if no active pending request exists yet for the item).
 * 2. `attachClientQuote({ requestId, quoteVersion, quote })` with `quote.simulated = false` FIRST.
 * 3. `decidePurchase({ requestId, quoteVersion: attached.quoteVersion, decision: 'approve' })` AFTER,
 *    putting the Convex order into `status = 'awaiting_client'` (skipping `SimulatedAmazonAdapter`)
 *    and returning the canonical `orderRef`.
 */
export async function coordinateConvexOneTapApproval(params: {
  coordinator: ConvexCheckoutCoordinator;
  item: CartItem;
  liveQuote: Quote;
  requestId?: string;
  quoteVersion?: number;
  now?: number;
}): Promise<ConvexCoordinationOutcome> {
  const now = params.now ?? Date.now();
  let requestId = params.requestId ?? params.item.pendingRequest?.requestId;
  let quoteVersion = params.quoteVersion ?? params.item.pendingRequest?.quoteVersion;

  if (!requestId && params.coordinator.findExistingOrderForItem) {
    try {
      const existingOrder = await params.coordinator.findExistingOrderForItem(params.item.id);
      if (existingOrder) {
        if (existingOrder.status === 'placed' && existingOrder.retailerOrderId) {
          return {
            ok: true,
            orderRef: existingOrder.orderRef,
            requestId: existingOrder.requestId,
            quoteVersion: quoteVersion ?? 1,
            alreadyPlacedOrderId: existingOrder.retailerOrderId,
            alreadyPlacedAt: existingOrder.placedAt ?? now,
          };
        }
        if (existingOrder.status === 'submitting' || existingOrder.status === 'unknown') {
          return {
            ok: false,
            status: 'safety_blocked',
            reason: `Convex order "${existingOrder.orderRef}" for item "${params.item.id}" is "${existingOrder.status}"; reconcile via syncOrders() before retrying.`,
          };
        }
        if (existingOrder.status === 'awaiting_client') {
          if (!params.coordinator.getPurchaseStatus) {
            if (
              existingOrder.quote &&
              Math.abs(existingOrder.quote.totalCents - params.liveQuote.totalCents) > 1
            ) {
              return {
                ok: false,
                status: 'requote_required',
                reason: `Live Amazon total (${params.liveQuote.totalCents} cents) changed from approved Convex quote (${existingOrder.quote.totalCents} cents).`,
              };
            }
            return {
              ok: true,
              orderRef: existingOrder.orderRef,
              requestId: existingOrder.requestId,
              quoteVersion: quoteVersion ?? 1,
              alreadyPlacedOrderId: null,
              alreadyPlacedAt: null,
            };
          }
          requestId = existingOrder.requestId;
        }
      }
    } catch {
      // Ignore lookup error and continue
    }
  }

  if (!requestId && params.coordinator.findPendingApprovalForItem) {
    try {
      const existingPending = await params.coordinator.findPendingApprovalForItem(params.item.id);
      if (
        existingPending &&
        (existingPending.status === 'pending_approval' || existingPending.status === 'quoting')
      ) {
        requestId = existingPending.requestId;
        quoteVersion = existingPending.quoteVersion;
      }
    } catch {
      // Ignore lookup error and fall back to requestPurchase
    }
  }

  if (requestId && params.coordinator.getPurchaseStatus) {
    try {
      const latest = await params.coordinator.getPurchaseStatus({ requestId });
      if (latest.order?.status === 'placed' && latest.order.retailerOrderId) {
        return {
          ok: true,
          orderRef: latest.order.orderRef,
          requestId: latest.requestId,
          quoteVersion: latest.quoteVersion,
          alreadyPlacedOrderId: latest.order.retailerOrderId,
          alreadyPlacedAt: latest.order.placedAt ?? now,
        };
      }
      if (
        latest.status === 'approved' &&
        latest.order?.status === 'awaiting_client' &&
        latest.order.orderRef
      ) {
        if (
          latest.quote &&
          Math.abs(latest.quote.totalCents - params.liveQuote.totalCents) > 1
        ) {
          return {
            ok: false,
            status: 'requote_required',
            reason: `Live Amazon total (${params.liveQuote.totalCents} cents) changed from approved Convex quote (${latest.quote.totalCents} cents).`,
          };
        }
        return {
          ok: true,
          orderRef: latest.order.orderRef,
          requestId: latest.requestId,
          quoteVersion: latest.quoteVersion,
          alreadyPlacedOrderId: null,
          alreadyPlacedAt: null,
        };
      }
      if (
        latest.order?.status === 'submitting' ||
        latest.order?.status === 'unknown'
      ) {
        return {
          ok: false,
          status: 'safety_blocked',
          reason: `Convex order "${latest.order.orderRef}" is "${latest.order.status}"; reconcile via syncOrders() before retrying.`,
        };
      }
      if (latest.status === 'quoting' || latest.status === 'pending_approval') {
        quoteVersion = latest.quoteVersion;
      } else {
        requestId = undefined;
        quoteVersion = undefined;
      }
    } catch {
      // Request missing or unreadable; create a fresh request below if offer exists
      requestId = undefined;
      quoteVersion = undefined;
    }
  }

  if (!requestId || typeof quoteVersion !== 'number') {
    const offerId = params.item.offer?.id ?? params.item.offers?.[0]?.id;
    if (!offerId) {
      return {
        ok: false,
        status: 'failed',
        reason: `Cannot start Convex purchase request for item "${params.item.id}": missing offerId.`,
      };
    }

    const created = await params.coordinator.requestPurchase({
      itemId: params.item.id,
      offerId,
      quantity: params.item.quantity,
      reason: 'One-tap Amazon checkout in Cart',
      idempotencyKey: `amz-checkout-${params.item.id}-q${params.item.quantity}`,
    });
    requestId = created.requestId;
    quoteVersion = created.quoteVersion;
  }

  // Step 2: attachClientQuote with simulated: false FIRST
  let attachedVersion: number;
  try {
    const attached = await params.coordinator.attachClientQuote(
      buildAttachClientQuoteArgs({
        requestId,
        quoteVersion,
        quote: params.liveQuote,
      }),
    );
    attachedVersion = attached.quoteVersion;
  } catch (err) {
    // One-shot refresh if internal resolveQuote bumped quoteVersion concurrently
    if (params.coordinator.getPurchaseStatus) {
      const refreshed = await params.coordinator.getPurchaseStatus({ requestId });
      if (refreshed.status === 'quoting' || refreshed.status === 'pending_approval') {
        const retried = await params.coordinator.attachClientQuote(
          buildAttachClientQuoteArgs({
            requestId,
            quoteVersion: refreshed.quoteVersion,
            quote: params.liveQuote,
          }),
        );
        attachedVersion = retried.quoteVersion;
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, status: 'failed', reason: msg };
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, status: 'failed', reason: msg };
    }
  }

  // Step 3: decidePurchase({ decision: 'approve' }) AFTER attachClientQuote
  const decided = await params.coordinator.decidePurchase({
    requestId,
    quoteVersion: attachedVersion,
    decision: 'approve',
  });

  if (decided.outcome === 'stale_quote') {
    return {
      ok: false,
      status: 'requote_required',
      reason: 'Convex quote version changed before approval could complete.',
    };
  }
  if (decided.outcome !== 'approved' && decided.outcome !== 'already_approved') {
    return {
      ok: false,
      status: 'failed',
      reason: `Convex decidePurchase returned "${decided.outcome}" instead of approving client execution.`,
    };
  }

  const canonicalOrderRef =
    decided.request.order?.orderRef ?? `CART-${requestId.slice(-10).toUpperCase()}`;

  if (
    decided.request.order?.status === 'placed' &&
    decided.request.order.retailerOrderId
  ) {
    return {
      ok: true,
      orderRef: canonicalOrderRef,
      requestId,
      quoteVersion: attachedVersion,
      alreadyPlacedOrderId: decided.request.order.retailerOrderId,
      alreadyPlacedAt: decided.request.order.placedAt ?? now,
    };
  }

  return {
    ok: true,
    orderRef: canonicalOrderRef,
    requestId,
    quoteVersion: attachedVersion,
    alreadyPlacedOrderId: null,
    alreadyPlacedAt: null,
  };
}

export interface SpcReviewInspection {
  stage: 'captcha_gate' | 'signin_gate' | 'checkout_review';
  signedIn: boolean;
  challenge?: AmazonAuthChallenge;
  canPlaceOrder: boolean;
  subtotalCents?: number | null;
  shippingCents?: number;
  taxCents?: number;
  totalCents?: number | null;
  summaryItemCount?: number | null;
  lineItems?: CheckoutReviewLineItem[];
  deliveryEstimate?: string;
  currentUrl: string;
}

export interface DeterministicCheckoutDeps {
  input: AmazonCheckoutItemInput;
  isSignedIn: () => boolean;
  ensureSignedIn: () => Promise<boolean>;
  closeBrowserSheet?: () => void;
  runExclusive: <T>(fn: () => Promise<T>) => Promise<T>;
  isolationDeps: Omit<SingleItemIsolationDeps, 'asin' | 'url' | 'quantity' | 'variantLabel'>;
  syncCartRowsToState: (rows: ScrapedAmazonCartRow[], syncedAt: number) => CartItem[];
  proceedToCheckoutAndInspect: () => Promise<SpcReviewInspection>;
  submitCheckoutOrder: (guard: {
    dryRun: boolean;
    userConfirmed: boolean;
    expectedTotalCents: number;
    approvedItems: ApprovedBasketItem[];
  }) => Promise<{
    submitted: boolean;
    haltedBySafetyGate: boolean;
    code?: string;
    reason?: string;
  }>;
  readConfirmation: () => Promise<{
    retailerOrderId: string | null;
    deliveryEstimate?: string | null;
    isConfirmationSurface?: boolean;
    hasAuthOrErrorBarrier?: boolean;
    currentUrl: string;
  }>;
  reconcileViaSyncOrders?: () => Promise<{
    purchases: Purchase[];
  }>;
  getPreExistingOrderIds: () => Iterable<string>;
  onOrderPlacedLocalState?: (params: {
    item: CartItem;
    orderRef: string;
    requestId: string;
    retailerOrderId: string;
    placedAt: number;
    quote: Quote;
    shipment: Shipment;
  }) => Promise<void> | void;
  submissionLedger: OrderSubmissionLedger;
  syncQueue: ConvexSyncRetryQueue;
  convexSync?: ConvexAmazonSyncClient;
  convexCoordinator?: ConvexCheckoutCoordinator;
  isSessionCurrent?: () => boolean;
  now?: () => number;
}

/**
 * End-to-end deterministic single-item Amazon checkout (`checkoutAmazonItem`):
 * 1. Sign-in gate (`ensureSignedIn()` -> clean `requires_signin` abort if dismissed).
 * 2. Single-item active-basket isolation on `/gp/cart/view.html` (`Save for later` on all
 *    other active rows + reload + `verifyActiveBasketBinding`).
 * 3. Live SPC checkout review inspection + `verifyCheckoutReviewBinding` + positive integer total check.
 * 4. Convex coordination (`requestPurchase -> attachClientQuote -> decidePurchase`) yielding canonical `orderRef`.
 * 5. Guarded `#placeYourOrder` click (`dryRun: false, userConfirmed: true` unless `input.dryRun === true`).
 * 6. Confirmation scrape (`###-#######-#######` + delivery date) + `recordClientPlacement` + `syncClientShipment`,
 *    falling back to `status: 'unknown'` + immediate `syncOrders()` reconciliation if DOM lacks the order ID.
 */
export async function executeDeterministicItemCheckout(
  deps: DeterministicCheckoutDeps,
): Promise<AmazonPlaceOrderResult> {
  const clock = deps.now ?? Date.now;
  const effectiveDryRun = deps.input.dryRun === true;
  const userConfirmed = !effectiveDryRun;
  const initialBinding = deps.submissionLedger.getItemBinding(deps.input.item.id);
  const initialOrderRef = deps.input.orderRef ?? initialBinding?.orderRef;
  const initialRequestId = deps.input.requestId ?? initialBinding?.requestId;
  const fallbackOrderRef =
    initialOrderRef ??
    (initialRequestId
      ? `CART-${initialRequestId.slice(-10).toUpperCase()}`
      : `CART-ITEM-${deps.input.item.id.slice(-10).toUpperCase()}`);

  const asin = extractAmazonItemAsin(deps.input.item);
  const specCheck = normalizeApprovedItems({
    asin,
    quantity: deps.input.item.quantity,
  });
  if (!specCheck.ok || !asin) {
    return {
      status: 'safety_blocked',
      safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
      orderRef: fallbackOrderRef,
      retailerOrderId: null,
      placedAt: null,
      quote: null,
      shipment: null,
      reason: specCheck.ok ? 'Missing Amazon ASIN on cart item.' : specCheck.reason,
    };
  }

  const targetItemSpec = specCheck.items[0]!;

  // Fast-path idempotent replay when a placed order already exists for this orderRef or bound itemId
  if (initialOrderRef && !effectiveDryRun) {
    const preEntry = deps.submissionLedger.get(initialOrderRef);
    if (preEntry?.state === 'placed') {
      const replaySync = await deps.syncQueue.flush(deps.convexSync);
      return {
        status: 'placed',
        safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
        orderRef: initialOrderRef,
        retailerOrderId: preEntry.retailerOrderId,
        placedAt: preEntry.placedAt,
        quote: null,
        shipment: null,
        reason: 'Idempotent replay: returning existing placed order.',
        syncError: replaySync.lastSyncError,
      };
    }
  }

  // Step 1: Sign-in gate BEFORE any cart or Convex mutations
  if (!deps.isSignedIn()) {
    const signedIn = await deps.ensureSignedIn();
    if (!signedIn) {
      return {
        status: 'requires_signin',
        safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
        orderRef: fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: null,
        shipment: null,
        reason: 'Amazon sign-in sheet was closed before signing in; checkout aborted cleanly.',
      };
    }
    deps.closeBrowserSheet?.();
  }

  return deps.runExclusive(async (): Promise<AmazonPlaceOrderResult> => {
    const activeBinding = deps.submissionLedger.getItemBinding(deps.input.item.id);
    const knownOrderRef = deps.input.orderRef ?? activeBinding?.orderRef;
    const knownRequestId = deps.input.requestId ?? activeBinding?.requestId;
    const knownQuoteVersion = deps.input.quoteVersion ?? activeBinding?.quoteVersion;

    // Pre-flight check inside exclusive WebView lock: if a prior attempt for this itemId/orderRef
    // is `placed` or `unknown`, reconcile via `syncOrders()` BEFORE isolating cart or minting a new request!
    if (knownOrderRef && !effectiveDryRun) {
      const currentLedger = deps.submissionLedger.get(knownOrderRef);
      if (currentLedger?.state === 'placed') {
        const replaySync = await deps.syncQueue.flush(deps.convexSync);
        return {
          status: 'placed',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef: knownOrderRef,
          retailerOrderId: currentLedger.retailerOrderId,
          placedAt: currentLedger.placedAt,
          quote: null,
          shipment: null,
          reason: 'Idempotent replay: returning existing placed order.',
          syncError: replaySync.lastSyncError,
        };
      }

      if (currentLedger?.state === 'unknown') {
        if (deps.reconcileViaSyncOrders) {
          try {
            const synced = await deps.reconcileViaSyncOrders();
            const postReconcile = deps.submissionLedger.get(knownOrderRef);
            if (postReconcile?.state === 'placed') {
              const matchedPurchase = synced.purchases.find(
                (p) => p.retailerOrderId === postReconcile.retailerOrderId,
              );
              const reconciledShipment: Shipment =
                matchedPurchase?.shipment ?? {
                  status: 'ordered',
                  carrier: null,
                  trackingNumber: null,
                  trackingUrl: null,
                  eta: null,
                  events: buildShipmentEvents({
                    status: 'ordered',
                    headline: 'Order reconciled from Amazon Your Orders',
                    placedAt: postReconcile.placedAt,
                    updatedAt: postReconcile.placedAt,
                  }),
                  updatedAt: postReconcile.placedAt,
                  simulated: false,
                };
              const reconciledQuote: Quote = matchedPurchase?.quote ?? {
                retailer: 'amazon',
                retailerName: 'Amazon',
                seller: deps.input.item.offer?.seller ?? 'Amazon.com',
                productTitle:
                  deps.input.item.product?.title ?? `Amazon Item ${targetItemSpec.asin}`,
                variantLabel: deps.input.item.variant?.label ?? null,
                imageUrl: deps.input.item.product?.imageUrl ?? null,
                quantity: targetItemSpec.quantity,
                unitPriceCents: Math.round(
                  currentLedger.expectedTotalCents / Math.max(1, targetItemSpec.quantity),
                ),
                subtotalCents: currentLedger.expectedTotalCents,
                taxCents: 0,
                shippingCents: 0,
                totalCents: currentLedger.expectedTotalCents,
                currency: 'USD',
                deliveryEstimate: 'Reconciled from Amazon Your Orders',
                returnSummary:
                  deps.input.item.offer?.returnSummary ?? '30-day Amazon return policy',
                quotedAt: postReconcile.placedAt,
                simulated: false,
              };

              await deps.syncQueue.enqueuePlacement(
                buildRecordClientPlacementArgs({
                  orderRef: knownOrderRef,
                  retailerOrderId: postReconcile.retailerOrderId,
                  placedAt: postReconcile.placedAt,
                  shipment: reconciledShipment,
                }),
                deps.convexSync,
              );
              const shipSync = await deps.syncQueue.enqueueShipment(
                buildSyncClientShipmentArgs({
                  orderRef: knownOrderRef,
                  retailerOrderId: postReconcile.retailerOrderId,
                  shipment: reconciledShipment,
                }),
                deps.convexSync,
              );

              await deps.onOrderPlacedLocalState?.({
                item: deps.input.item,
                orderRef: knownOrderRef,
                requestId: knownRequestId ?? `req_${postReconcile.placedAt.toString(36)}`,
                retailerOrderId: postReconcile.retailerOrderId,
                placedAt: postReconcile.placedAt,
                quote: reconciledQuote,
                shipment: reconciledShipment,
              });

              return {
                status: 'placed',
                safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
                orderRef: knownOrderRef,
                retailerOrderId: postReconcile.retailerOrderId,
                placedAt: postReconcile.placedAt,
                quote: reconciledQuote,
                shipment: reconciledShipment,
                reason: 'Reconciled previously submitted order from Amazon Your Orders.',
                syncError: shipSync.lastSyncError ?? deps.syncQueue.lastSyncError,
              };
            }
          } catch {
            // Keep entry in 'unknown' and fail closed below
          }
        }

        return {
          status: 'unknown',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef: knownOrderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: null,
          shipment: null,
          reason:
            'Previous submission for this item had an unconfirmed outcome and has not yet appeared in Amazon Your Orders; refusing to submit a duplicate order.',
          syncError: deps.syncQueue.lastSyncError,
        };
      }
    }

    // Step 2: Single-item active-basket isolation on /gp/cart/view.html
    const isolation = await isolateSingleActiveCartItem({
      ...deps.isolationDeps,
      asin: targetItemSpec.asin,
      url: deps.input.item.url,
      quantity: targetItemSpec.quantity,
      variantLabel: deps.input.item.variant?.label ?? null,
    });

    if (isolation.cartSnap) {
      deps.syncCartRowsToState(isolation.cartSnap.items, clock());
    }

    if (!isolation.ok) {
      return {
        status: isolation.status,
        safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
        orderRef: knownOrderRef ?? fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: null,
        shipment: null,
        reason: isolation.reason,
      };
    }

    // Step 3: Proceed to SPC checkout review & scrape live single-item quote
    const review = await deps.proceedToCheckoutAndInspect();
    if (review.stage === 'signin_gate' || review.stage === 'captcha_gate') {
      return {
        status: 'requires_signin',
        safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
        orderRef: knownOrderRef ?? fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: null,
        shipment: null,
        reason:
          review.stage === 'captcha_gate'
            ? 'Amazon requested CAPTCHA verification before checkout review.'
            : 'Amazon requested re-authentication before checkout review.',
      };
    }

    const reviewBinding = verifyCheckoutReviewBinding({
      approvedItems: [targetItemSpec],
      summaryItemCount: review.summaryItemCount,
      lineItems: review.lineItems,
    });
    if (!reviewBinding.ok) {
      return {
        status: 'basket_mismatch',
        safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
        orderRef: knownOrderRef ?? fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: null,
        shipment: null,
        reason: reviewBinding.reason,
      };
    }

    if (!isValidPositiveCents(review.totalCents)) {
      return {
        status: 'safety_blocked',
        safetyGate: { dryRun: effectiveDryRun, userConfirmed, orderSubmitted: false },
        orderRef: knownOrderRef ?? fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: null,
        shipment: null,
        reason:
          'Fail-closed: live checkout grand total could not be parsed on the Amazon checkout review screen.',
      };
    }

    const matchedRow = isolation.matchedRows[0];
    const activeSubtotalCents = isolation.matchedRows.reduce(
      (sum, r) => sum + r.unitPriceCents * r.quantity,
      0,
    );
    const totalCents = review.totalCents;
    const subtotalCents = isValidPositiveCents(review.subtotalCents)
      ? review.subtotalCents
      : activeSubtotalCents;
    const shippingCents = review.shippingCents ?? 0;
    const taxCents =
      typeof review.taxCents === 'number' && review.taxCents >= 0
        ? review.taxCents
        : Math.max(
            0,
            totalCents - subtotalCents - shippingCents ||
              Math.round(subtotalCents * ESTIMATED_TAX_RATE),
          );
    const unitPriceCents =
      matchedRow?.unitPriceCents ||
      Math.round(subtotalCents / Math.max(1, targetItemSpec.quantity));
    const quotedAt = clock();

    const liveQuote: Quote = {
      retailer: 'amazon',
      retailerName: 'Amazon',
      seller: deps.input.item.offer?.seller ?? matchedRow?.seller ?? 'Amazon.com',
      productTitle:
        deps.input.item.product?.title ?? matchedRow?.title ?? `Amazon Item ${targetItemSpec.asin}`,
      variantLabel: deps.input.item.variant?.label ?? null,
      imageUrl: deps.input.item.product?.imageUrl ?? matchedRow?.imageUrl ?? null,
      quantity: targetItemSpec.quantity,
      unitPriceCents,
      subtotalCents,
      taxCents,
      shippingCents,
      totalCents,
      currency: 'USD',
      deliveryEstimate:
        review.deliveryEstimate ??
        deps.input.item.offer?.deliveryEstimate ??
        'Amazon checkout delivery',
      returnSummary:
        deps.input.item.offer?.returnSummary ?? '30-day Amazon return policy',
      quotedAt,
      simulated: false,
    };

    // Dry-run halt BEFORE Convex purchase approval or #placeYourOrder click
    if (effectiveDryRun) {
      return {
        status: 'dry_run_halted',
        safetyGate: { dryRun: true, userConfirmed: false, orderSubmitted: false },
        orderRef: knownOrderRef ?? fallbackOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: liveQuote,
        shipment: null,
        reason:
          'Halted by dryRun safety gate on SPC checkout review after single-item active-basket isolation.',
      };
    }

    // Step 4: Convex Coordination (requestPurchase -> attachClientQuote -> decidePurchase)
    let canonicalOrderRef = knownOrderRef ?? fallbackOrderRef;
    let canonicalRequestId = knownRequestId ?? `req_${deps.input.item.id}`;
    let canonicalQuoteVersion = knownQuoteVersion ?? 1;

    if (!deps.input.orderRef && deps.convexCoordinator) {
      const coord = await coordinateConvexOneTapApproval({
        coordinator: deps.convexCoordinator,
        item: deps.input.item,
        liveQuote,
        requestId: knownRequestId,
        quoteVersion: knownQuoteVersion,
        now: quotedAt,
      });

      if (!coord.ok) {
        return {
          status: coord.status,
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef: canonicalOrderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: liveQuote,
          shipment: null,
          reason: coord.reason,
        };
      }

      canonicalOrderRef = coord.orderRef;
      canonicalRequestId = coord.requestId;
      canonicalQuoteVersion = coord.quoteVersion;

      // Persist per-item checkout identity BEFORE any submission attempt
      deps.submissionLedger.bindItemCheckout({
        itemId: deps.input.item.id,
        requestId: canonicalRequestId,
        quoteVersion: canonicalQuoteVersion,
        orderRef: canonicalOrderRef,
        asin: targetItemSpec.asin,
        quantity: targetItemSpec.quantity,
      });

      if (coord.alreadyPlacedOrderId) {
        deps.submissionLedger.recordPlaced(
          canonicalOrderRef,
          coord.alreadyPlacedOrderId,
          coord.alreadyPlacedAt ?? quotedAt,
        );
        return {
          status: 'placed',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef: canonicalOrderRef,
          retailerOrderId: coord.alreadyPlacedOrderId,
          placedAt: coord.alreadyPlacedAt ?? quotedAt,
          quote: liveQuote,
          shipment: null,
          reason: 'Idempotent replay: Convex order was already recorded as placed.',
        };
      }
    } else {
      // Standalone mode (no Convex coordinator): still bind itemId -> canonicalOrderRef before submit
      deps.submissionLedger.bindItemCheckout({
        itemId: deps.input.item.id,
        requestId: canonicalRequestId,
        quoteVersion: canonicalQuoteVersion,
        orderRef: canonicalOrderRef,
        asin: targetItemSpec.asin,
        quantity: targetItemSpec.quantity,
      });
    }

    // Re-check ledger on canonicalOrderRef before clicking #placeYourOrder
    const canonicalLedgerEntry = deps.submissionLedger.get(canonicalOrderRef);
    if (canonicalLedgerEntry?.state === 'placed') {
      const replayFlush = await deps.syncQueue.flush(deps.convexSync);
      return {
        status: 'placed',
        safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
        orderRef: canonicalOrderRef,
        retailerOrderId: canonicalLedgerEntry.retailerOrderId,
        placedAt: canonicalLedgerEntry.placedAt,
        quote: liveQuote,
        shipment: null,
        reason: 'Idempotent replay: returning existing placed order.',
        syncError: replayFlush.lastSyncError,
      };
    }
    if (canonicalLedgerEntry?.state === 'unknown') {
      return {
        status: 'unknown',
        safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
        orderRef: canonicalOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: liveQuote,
        shipment: null,
        reason:
          'Previous submission for this orderRef had an unconfirmed outcome; reconcile via syncOrders() before retrying.',
        syncError: deps.syncQueue.lastSyncError,
      };
    }

    // Step 5: Host + In-DOM Safety Gate -> Deterministic #placeYourOrder Click
    const gateDecision = evaluatePreSubmitSafetyGate({
      dryRun: false,
      userConfirmed: true,
      approvedItems: [targetItemSpec],
      expectedTotalCents: liveQuote.totalCents,
      requiresSignIn: false,
      basketBound: true,
      checkoutReviewBound: true,
      liveTotalVerified: true,
      liveTotalCents: liveQuote.totalCents,
    });

    if (!gateDecision.allowSubmit) {
      return {
        status: gateDecision.status,
        safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
        orderRef: canonicalOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: liveQuote,
        shipment: null,
        reason: gateDecision.reason,
      };
    }

    const submitRes = await deps.submitCheckoutOrder({
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: gateDecision.expectedTotalCents,
      approvedItems: gateDecision.approvedItems,
    });

    if (!submitRes.submitted) {
      const blockedStatus: PlaceOrderExecutionStatus =
        submitRes.code === 'requote_required'
          ? 'requote_required'
          : submitRes.code === 'basket_mismatch'
            ? 'basket_mismatch'
            : submitRes.haltedBySafetyGate
              ? 'safety_blocked'
              : 'failed';
      return {
        status: blockedStatus,
        safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
        orderRef: canonicalOrderRef,
        retailerOrderId: null,
        placedAt: null,
        quote: liveQuote,
        shipment: null,
        reason: submitRes.reason,
      };
    }

    // Step 6: Order Confirmation Scrape + Convex Placement & Shipment Sync
    const settled = await settleSubmittedOrderConfirmation({
      orderRef: canonicalOrderRef,
      submittedAt: clock(),
      approvedItems: gateDecision.approvedItems,
      expectedTotalCents: gateDecision.expectedTotalCents,
      preExistingOrderIds: deps.getPreExistingOrderIds(),
      verifiedQuote: liveQuote,
      ledger: deps.submissionLedger,
      syncQueue: deps.syncQueue,
      convexSync: deps.convexSync,
      isSessionCurrent: deps.isSessionCurrent,
      readConfirmation: deps.readConfirmation,
    });

    if (settled.status === 'placed' && settled.retailerOrderId && settled.shipment) {
      const shipSync = await deps.syncQueue.enqueueShipment(
        buildSyncClientShipmentArgs({
          orderRef: canonicalOrderRef,
          retailerOrderId: settled.retailerOrderId,
          shipment: settled.shipment,
        }),
        deps.convexSync,
      );
      await deps.onOrderPlacedLocalState?.({
        item: deps.input.item,
        orderRef: canonicalOrderRef,
        requestId: canonicalRequestId,
        retailerOrderId: settled.retailerOrderId,
        placedAt: settled.placedAt ?? clock(),
        quote: settled.quote ?? liveQuote,
        shipment: settled.shipment,
      });
      return {
        ...settled,
        syncError: shipSync.lastSyncError ?? settled.syncError,
      };
    }

    // Immediate fallback reconciliation via `syncOrders()` INSIDE the exclusive WebView lock
    // so queued browser commands can never interleave with Your Orders / tracking navigation!
    if (settled.status === 'unknown' && deps.reconcileViaSyncOrders) {
      try {
        const synced = await deps.reconcileViaSyncOrders();
        const postLedger = deps.submissionLedger.get(canonicalOrderRef);
        if (postLedger?.state === 'placed') {
          const matchedPurchase = synced.purchases.find(
            (p) => p.retailerOrderId === postLedger.retailerOrderId,
          );
          const fallbackShipment: Shipment =
            matchedPurchase?.shipment ?? {
              status: 'ordered',
              carrier: null,
              trackingNumber: null,
              trackingUrl: null,
              eta: parseDeliveryEtaIso(liveQuote.deliveryEstimate, postLedger.placedAt),
              events: buildShipmentEvents({
                status: 'ordered',
                headline: 'Order reconciled from Amazon Your Orders',
                placedAt: postLedger.placedAt,
                updatedAt: postLedger.placedAt,
              }),
              updatedAt: postLedger.placedAt,
              simulated: false,
            };

          await deps.onOrderPlacedLocalState?.({
            item: deps.input.item,
            orderRef: canonicalOrderRef,
            requestId: canonicalRequestId,
            retailerOrderId: postLedger.retailerOrderId,
            placedAt: postLedger.placedAt,
            quote: liveQuote,
            shipment: fallbackShipment,
          });

          return {
            status: 'placed',
            safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
            orderRef: canonicalOrderRef,
            retailerOrderId: postLedger.retailerOrderId,
            placedAt: postLedger.placedAt,
            quote: liveQuote,
            shipment: fallbackShipment,
            syncError: deps.syncQueue.lastSyncError,
          };
        }
      } catch {
        // Retain 'unknown' in OrderSubmissionLedger so the 30s background poller or next retry reconciles
      }
    }

    return settled;
  });
}

/**
 * Helper to isolate a single item and fetch its live SPC dry-run quote without placing an order.
 * Used by `<AmazonSyncDaemon />` when `api.purchases.listPendingApprovals` has an unquoted or
 * simulated Amazon request while the shopper is signed in.
 */
export async function quoteIsolatedSingleCartItem(params: {
  asin: string;
  url: string;
  quantity: number;
  productTitle?: string;
  seller?: string;
  imageUrl?: string | null;
  variantLabel?: string | null;
  returnSummary?: string;
  isolationDeps: Omit<SingleItemIsolationDeps, 'asin' | 'url' | 'quantity' | 'variantLabel'>;
  syncCartRowsToState: (rows: ScrapedAmazonCartRow[], syncedAt: number) => CartItem[];
  proceedToCheckoutAndInspect: () => Promise<SpcReviewInspection>;
  now?: () => number;
}): Promise<AmazonCheckoutQuoteResult> {
  const clock = params.now ?? Date.now;
  const isolation = await isolateSingleActiveCartItem({
    ...params.isolationDeps,
    asin: params.asin,
    url: params.url,
    quantity: params.quantity,
    variantLabel: params.variantLabel ?? null,
  });

  const quotedAt = clock();
  if (isolation.cartSnap) {
    params.syncCartRowsToState(isolation.cartSnap.items, quotedAt);
  }

  if (!isolation.ok) {
    return {
      ok: false,
      dryRun: true,
      requiresSignIn: isolation.status === 'requires_signin',
      haltedAt: isolation.status === 'requires_signin' ? 'signin_gate' : 'basket_mismatch',
      canPlaceOrder: false,
      liveTotalVerified: false,
      basketBound: false,
      approvedItems: [],
      quote: null,
      currentUrl: isolation.cartSnap?.currentUrl ?? AMAZON_CART_URL,
      quotedAt,
      error: isolation.reason,
    };
  }

  const targetSpec: ApprovedBasketItem = {
    asin: params.asin.trim().toUpperCase(),
    quantity: Math.max(1, Math.min(10, Math.floor(params.quantity))),
  };
  const review = await params.proceedToCheckoutAndInspect();
  if (review.stage === 'signin_gate' || review.stage === 'captcha_gate') {
    return {
      ok: false,
      dryRun: true,
      requiresSignIn: true,
      haltedAt: review.stage,
      canPlaceOrder: false,
      liveTotalVerified: false,
      basketBound: true,
      approvedItems: [targetSpec],
      quote: null,
      currentUrl: review.currentUrl,
      quotedAt: clock(),
      error: 'Amazon sign-in or CAPTCHA required during SPC quote inspection.',
    };
  }

  const reviewBinding = verifyCheckoutReviewBinding({
    approvedItems: [targetSpec],
    summaryItemCount: review.summaryItemCount,
    lineItems: review.lineItems,
  });
  if (!reviewBinding.ok) {
    return {
      ok: false,
      dryRun: true,
      requiresSignIn: false,
      haltedAt: 'basket_mismatch',
      canPlaceOrder: false,
      liveTotalVerified: false,
      basketBound: false,
      approvedItems: [targetSpec],
      quote: null,
      currentUrl: review.currentUrl,
      quotedAt: clock(),
      error: reviewBinding.reason,
    };
  }

  if (!isValidPositiveCents(review.totalCents)) {
    return {
      ok: false,
      dryRun: true,
      requiresSignIn: false,
      haltedAt: 'total_unverified',
      canPlaceOrder: false,
      liveTotalVerified: false,
      basketBound: true,
      approvedItems: [targetSpec],
      quote: null,
      currentUrl: review.currentUrl,
      quotedAt: clock(),
      error: 'Live SPC grand total could not be verified.',
    };
  }

  const matchedRow = isolation.matchedRows[0];
  const activeSubtotalCents = isolation.matchedRows.reduce(
    (sum, r) => sum + r.unitPriceCents * r.quantity,
    0,
  );
  const totalCents = review.totalCents;
  const subtotalCents = isValidPositiveCents(review.subtotalCents)
    ? review.subtotalCents
    : activeSubtotalCents;
  const shippingCents = review.shippingCents ?? 0;
  const taxCents =
    typeof review.taxCents === 'number' && review.taxCents >= 0
      ? review.taxCents
      : Math.max(0, totalCents - subtotalCents - shippingCents);
  const unitPriceCents =
    matchedRow?.unitPriceCents || Math.round(subtotalCents / Math.max(1, targetSpec.quantity));

  const verifiedQuote: Quote = {
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller: params.seller ?? matchedRow?.seller ?? 'Amazon.com',
    productTitle: params.productTitle ?? matchedRow?.title ?? `Amazon Item ${targetSpec.asin}`,
    variantLabel: params.variantLabel ?? null,
    imageUrl: params.imageUrl ?? matchedRow?.imageUrl ?? null,
    quantity: targetSpec.quantity,
    unitPriceCents,
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents,
    currency: 'USD',
    deliveryEstimate: review.deliveryEstimate ?? 'Amazon checkout delivery',
    returnSummary: params.returnSummary ?? '30-day Amazon return policy',
    quotedAt: clock(),
    simulated: false,
  };

  return {
    ok: true,
    dryRun: true,
    requiresSignIn: false,
    haltedAt: 'checkout_review',
    canPlaceOrder: review.canPlaceOrder,
    liveTotalVerified: true,
    basketBound: true,
    approvedItems: [targetSpec],
    quote: verifiedQuote,
    currentUrl: review.currentUrl,
    quotedAt: verifiedQuote.quotedAt,
  };
}
