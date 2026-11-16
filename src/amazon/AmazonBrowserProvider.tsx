import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  AppState,
  BackHandler,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { type Palette, Spacing, Type, useThemedStyles } from '@/constants/theme';

import { AmazonSyncDaemon } from './AmazonSyncDaemon';
import { AMAZON_LIVE_SUBMISSION_ENABLED, DurableSubmissionClaims, PersistedBrowserOwner } from './durable-safety';
import {
  AMAZON_CART_URL,
  AMAZON_ORDERS_URL,
  AMAZON_SIGNIN_URL,
  AMAZON_SIGNOUT_URL,
  amazonOfferListingUrl,
  buildShipmentEvents,
  canonicalAmazonProductUrl,
  extractAsin,
  isAmazonShortLink,
  normalizeShipmentStatus,
  parseDeliveryEtaIso,
} from './asin';
import {
  type AttachClientQuoteArgs,
  buildAttachClientQuoteArgs,
  buildSyncClientShipmentArgs,
  type ConvexAmazonSyncClient,
  type SyncClientShipmentArgs,
} from './convex-sync';
import {
  AmazonDaemonBridgeContext,
  type AmazonDaemonBridgeValue,
} from './daemon-bridge-context';
import {
  type CartSnapshotScrape,
  type ConvexCheckoutCoordinator,
  executeDeterministicItemCheckout,
  HEARTBEAT_INTERVAL_MS,
  InMemoryKeyValueStorage,
  type KeyValueStorageAdapter,
  quoteIsolatedSingleCartItem,
  selectBrowserEngine,
  selectBrowserUserAgent,
  shouldRunIdleHeartbeat,
  type SpcReviewInspection,
  SyncedCartLedger,
} from './daemon-engine';
import {
  type AmazonCartSyncValue,
  type OwnedCartDeltaInput,
  type OwnedCartDeltaResult,
  OwnedCartSync,
} from './owned-cart-sync';
import {
  applyLedgerReconciliationsToState,
  computeLiveCartQuantityPlan,
  ConvexSyncRetryQueue,
  executeIdempotentAddItem,
  resetAmazonSessionStores,
  selectVerifiedAddedCartItem,
  SessionResetBarrier,
  settleSubmittedOrderConfirmation,
  verifyFinalCartRowQuantity,
} from './reconcile-sync';
import {
  evaluatePreSubmitSafetyGate,
  isValidPositiveCents,
  normalizeApprovedItems,
  OrderSubmissionLedger,
  shouldStartFreshSignInNavigation,
  verifyActiveBasketBinding,
  verifyCheckoutReviewBinding,
} from './safety';
import {
  AMAZON_PAGE_BOOTSTRAP_JS,
  buildAodAddToCartScript,
  buildClearWebViewSessionScript,
  buildClickProceedToCheckoutScript,
  buildInspectCheckoutReviewScript,
  buildMoveSavedToCartScript,
  buildMutateCartRowScript,
  buildProductScrapeAndAddScript,
  buildResolvePageAsinScript,
  buildSaveCartRowForLaterScript,
  buildScrapeCartScript,
  buildScrapeOrderConfirmationScript,
  buildScrapeProgressTrackerScript,
  buildScrapeYourOrdersScript,
  buildSessionCheckScript,
  buildSubmitCheckoutOrderScript,
} from './scripts';
import type {
  AmazonAddToCartInput,
  AmazonAddToCartResult,
  AmazonAuthChallenge,
  AmazonCartAdapterValue,
  AmazonCheckoutItemInput,
  AmazonCheckoutQuoteInput,
  AmazonCheckoutQuoteResult,
  AmazonPlaceOrderInput,
  AmazonPlaceOrderResult,
  AmazonSessionCheckResult,
  AmazonSessionHookValue,
  AmazonSessionStatus,
  AmazonSyncOrdersResult,
  ApprovedBasketItem,
  CartItem,
  CheckoutReviewLineItem,
  DecidePurchaseOutcome,
  Offer,
  PlaceOrderExecutionStatus,
  Purchase,
  PurchaseRequest,
  Quote,
  RawScrapedTrackingEvent,
  ScrapedAmazonCartRow,
  Shipment,
} from './types';

type NativeWebViewInstance = WebView<Record<string, unknown>>;

const ESTIMATED_TAX_RATE = 0.0825;
const QUOTE_TTL_MS = 30 * 60 * 1000;

function createPlatformStorageAdapter(): KeyValueStorageAdapter {
  if (Platform.OS === 'web') {
    return new InMemoryKeyValueStorage();
  }
  const memoryFallback = new InMemoryKeyValueStorage();
  return {
    getItem: async (key: string) => {
      try {
        return await SecureStore.getItemAsync(key);
      } catch {
        return memoryFallback.getItem(key);
      }
    },
    setItem: async (key: string, value: string) => {
      memoryFallback.setItem(key, value);
      try {
        await SecureStore.setItemAsync(key, value);
      } catch {
        // Retained in memoryFallback if SecureStore rejects or is unavailable
      }
    },
    removeItem: async (key: string) => {
      memoryFallback.removeItem(key);
      try {
        await SecureStore.deleteItemAsync(key);
      } catch {
        // Ignore SecureStore deletion errors
      }
    },
  };
}

interface ProductMetadataCacheEntry {
  asin: string;
  title: string;
  unitPriceCents: number | null;
  listPriceCents: number | null;
  imageUrl: string | null;
  deliveryEstimate: string;
  seller: string;
  variantLabel: string;
  rating: { average: number; count: number } | null;
}

interface PendingStepResolver {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPageReadyWaiter {
  predicate: (url: string) => boolean;
  resolve: (info: { url: string; signedIn: boolean; challenge: AmazonAuthChallenge }) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface CombinedAmazonContextValue {
  session: AmazonSessionHookValue;
  adapter: AmazonCartAdapterValue;
  cartSync: AmazonCartSyncValue;
}

const AmazonContext = createContext<CombinedAmazonContextValue | null>(null);

function buildCartItemFromScrapedRow(
  row: ScrapedAmazonCartRow,
  cached: ProductMetadataCacheEntry | undefined,
  existing: CartItem | undefined,
  now: number,
): CartItem {
  const asin = row.asin.toUpperCase();
  const itemId = existing?.id ?? `amz-item-${asin}`;
  const offerId = `amz-offer-${asin}`;
  const priceCents = row.unitPriceCents || cached?.unitPriceCents || 0;
  const listPriceCents = row.listPriceCents ?? cached?.listPriceCents ?? null;
  const subtotalCents = priceCents * row.quantity;
  const shippingCents = 0;
  const taxCents = Math.round(subtotalCents * ESTIMATED_TAX_RATE);
  const totalCents = subtotalCents + shippingCents + taxCents;
  const title =
    row.title && !row.title.startsWith('Amazon Item ')
      ? row.title
      : cached?.title ?? row.title;
  const imageUrl = row.imageUrl ?? cached?.imageUrl ?? existing?.product?.imageUrl ?? null;
  const seller = cached?.seller ?? row.seller ?? 'Amazon.com';
  const deliveryEstimate = cached?.deliveryEstimate ?? row.deliveryEstimate;
  const variantLabel = cached?.variantLabel ?? existing?.variant?.label ?? 'Standard';
  const ratingBase = cached?.rating ?? null;

  const offer: Offer = {
    id: offerId,
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller,
    url: canonicalAmazonProductUrl(asin),
    variantId: `${asin}-default`,
    variantLabel,
    priceCents,
    listPriceCents,
    shippingCents,
    currency: 'USD',
    deliveryEstimate,
    returnSummary: row.returnSummary,
    rating: ratingBase,
    inStock: row.inStock,
    simulated: false,
    updatedAt: now,
  };

  const prevPoints = existing?.priceHistory?.points ?? [];
  const nextPoints =
    prevPoints.length > 0 && prevPoints[prevPoints.length - 1]?.priceCents === priceCents
      ? prevPoints
      : [
          ...prevPoints,
          { observedAt: now, priceCents, source: 'amazon-webview', simulated: false },
        ];
  const allPointValues = nextPoints.map((p) => p.priceCents);

  return {
    id: itemId,
    url: canonicalAmazonProductUrl(asin),
    status: 'active',
    quantity: row.quantity,
    reason: existing?.reason ?? null,
    addedBy: existing?.addedBy ?? 'app',
    addedAt: existing?.addedAt ?? now,
    enrichmentStatus: 'ready',
    product: {
      id: `amz-prod-${asin}`,
      title,
      brand: title.split(' ')[0] ?? null,
      category: 'Amazon',
      imageUrl,
      description: null,
    },
    variant: {
      id: `${asin}-default`,
      label: variantLabel,
    },
    offer,
    offers: [offer],
    rating: ratingBase
      ? {
          average: ratingBase.average,
          count: ratingBase.count,
          retailers: [
            { retailerName: 'Amazon', average: ratingBase.average, count: ratingBase.count },
          ],
        }
      : existing?.rating ?? null,
    price: {
      currentCents: priceCents,
      listPriceCents,
      currency: 'USD',
      subtotalCents,
      taxCents,
      shippingCents,
      totalCents,
      estimated: true,
    },
    priceHistory: {
      points: nextPoints,
      lowCents: allPointValues.length > 0 ? Math.min(...allPointValues) : priceCents,
      highCents: allPointValues.length > 0 ? Math.max(...allPointValues) : priceCents,
      currentCents: priceCents,
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export interface AmazonBrowserProviderProps {
  children: React.ReactNode;
  /**
   * Optional authenticated shopper identity (`userId` / subject).
   * When `shopperId` transitions from a non-null ID to `null` (sign-out) or to a different
   * shopper ID (account switch), `resetSession()` automatically wipes Amazon WebKit cookies,
   * cached orders, cart items, and pending sync state.
   */
  shopperId?: string | null;
  /**
   * Optional 5-line bridge to Convex client-sync mutations (`MOBI-9`):
   * `attachClientQuote`, `recordClientPlacement`, and `syncClientShipment`.
   * When omitted inside `<ConvexProvider>`, `<AmazonSyncDaemon />` wires it automatically.
   */
  convexSync?: ConvexAmazonSyncClient;
  /**
   * Opt-in background automation. Defaults to `false`: no `<AmazonSyncDaemon />` (Convex
   * subscriptions, cart pollers, live quote attachment, order polling), no idle heartbeat,
   * no AppState foreground cart/order sync, and no automatic retry-queue flush. Pass `true`
   * only after the background cart/backend writes have been approved for the release.
   */
  enableBackendDaemon?: boolean;
}

export function AmazonBrowserProvider({
  children,
  shopperId = null,
  convexSync,
  enableBackendDaemon = false,
}: AmazonBrowserProviderProps) {
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const styles = useThemedStyles(createProviderStyles);
  const [safetyStorage] = useState(() => ({
    getItem: (key: string) => SecureStore.getItemAsync(key),
    setItem: (key: string, value: string) => SecureStore.setItemAsync(key, value),
  }));
  const ownerScope = useMemo(() => ({ shopperId, owner: new PersistedBrowserOwner(safetyStorage) }), [safetyStorage, shopperId]);
  const browserOwner = ownerScope.owner;
  const [submissionClaims] = useState(() => new DurableSubmissionClaims(safetyStorage));
  const ownerIsReady = useCallback(() => browserOwner.isReady(shopperId), [browserOwner, shopperId]);
  const ownerReady = useSyncExternalStore(browserOwner.subscribe, ownerIsReady, () => false);
  const webViewRef = useRef<NativeWebViewInstance | null>(null);
  const autoConvexSyncRef = useRef<ConvexAmazonSyncClient | undefined>(undefined);
  const autoCheckoutCoordinatorRef = useRef<ConvexCheckoutCoordinator | undefined>(undefined);
  const convexSyncRef = useRef<ConvexAmazonSyncClient | undefined>(convexSync);
  const [sessionBarrier] = useState(() => new SessionResetBarrier());
  const checkoutInFlightCountRef = useRef(0);
  const canGoBackRef = useRef(false);
  const lastHeartbeatAtRef = useRef(0);
  const knownConvexOrderRefByRetailerIdRef = useRef<Map<string, string>>(new Map());
  const [syncedCartLedger] = useState(
    () => new SyncedCartLedger(createPlatformStorageAdapter(), shopperId),
  );
  const [ownedCartSync] = useState(() => new OwnedCartSync({ storage: createPlatformStorageAdapter() }));

  const [isSignedIn, setIsSignedIn] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string>(AMAZON_CART_URL);
  const [challenge, setChallenge] = useState<AmazonAuthChallenge>('none');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [lastSyncError, setLastSyncError] = useState<string | null>(null);
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  const [items, setItems] = useState<CartItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchasedItems, setPurchasedItems] = useState<Record<string, CartItem>>({});
  const [pendingRequests, setPendingRequests] = useState<PurchaseRequest[]>([]);

  const itemsRef = useRef<CartItem[]>(items);
  const purchasesRef = useRef<Purchase[]>(purchases);
  const purchasedItemsRef = useRef<Record<string, CartItem>>(purchasedItems);
  const pendingRequestsRef = useRef<PurchaseRequest[]>(pendingRequests);
  const isSignedInRef = useRef(isSignedIn);
  const busyCountRef = useRef(busyCount);
  const isSheetOpenRef = useRef(isSheetOpen);
  const challengeRef = useRef<AmazonAuthChallenge>(challenge);
  const lastSyncedAtRef = useRef<number | null>(lastSyncedAt);
  const currentUrlRef = useRef(currentUrl);

  const [syncQueue] = useState(
    () =>
      new ConvexSyncRetryQueue((snap) => {
        setPendingSyncCount(snap.pendingCount);
        setLastSyncError(snap.lastSyncError);
      }),
  );

  useEffect(() => {
    const effective = convexSync ?? autoConvexSyncRef.current;
    convexSyncRef.current = effective;
    if (enableBackendDaemon && effective && ownerIsReady() && !sessionBarrier.isLogoutPending) {
      void syncQueue.flush(effective);
    }
  }, [convexSync, enableBackendDaemon, ownerIsReady, sessionBarrier, syncQueue]);

  const registerAutoConvexBridge = useCallback(
    (bridge: {
      syncClient: ConvexAmazonSyncClient | undefined;
      checkoutCoordinator: ConvexCheckoutCoordinator | undefined;
    }) => {
      if (!ownerIsReady()) return;
      autoConvexSyncRef.current = bridge.syncClient;
      autoCheckoutCoordinatorRef.current = bridge.checkoutCoordinator;
      const effective = convexSync ?? bridge.syncClient;
      convexSyncRef.current = effective;
      if (effective && ownerIsReady() && !sessionBarrier.isLogoutPending) {
        void syncQueue.flush(effective);
      }
    },
    [convexSync, ownerIsReady, sessionBarrier, syncQueue],
  );

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(() => {
    purchasesRef.current = purchases;
  }, [purchases]);
  useEffect(() => {
    purchasedItemsRef.current = purchasedItems;
  }, [purchasedItems]);
  useEffect(() => {
    pendingRequestsRef.current = pendingRequests;
  }, [pendingRequests]);
  useEffect(() => {
    isSignedInRef.current = isSignedIn;
  }, [isSignedIn]);
  useEffect(() => {
    busyCountRef.current = busyCount;
  }, [busyCount]);
  useEffect(() => {
    isSheetOpenRef.current = isSheetOpen;
  }, [isSheetOpen]);
  useEffect(() => {
    challengeRef.current = challenge;
  }, [challenge]);
  useEffect(() => {
    lastSyncedAtRef.current = lastSyncedAt;
  }, [lastSyncedAt]);
  useEffect(() => {
    currentUrlRef.current = currentUrl;
  }, [currentUrl]);

  const productCacheRef = useRef<Map<string, ProductMetadataCacheEntry>>(new Map());
  const idempotencyMapRef = useRef<Map<string, string>>(new Map());
  const submissionLedgerRef = useRef<OrderSubmissionLedger>(new OrderSubmissionLedger());
  const stepResolversRef = useRef<Map<string, PendingStepResolver>>(new Map());
  const pageWaitersRef = useRef<Set<PendingPageReadyWaiter>>(new Set());
  const signInWaitersRef = useRef<Set<(signedIn: boolean) => void>>(new Set());
  const commandQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const reqSeqRef = useRef(0);

  const settleSignInWaiters = useCallback((result: boolean) => {
    if (signInWaitersRef.current.size === 0) return;
    const waiters = Array.from(signInWaitersRef.current);
    signInWaitersRef.current.clear();
    for (const resolve of waiters) {
      resolve(result);
    }
  }, []);

  useLayoutEffect(() => {
    browserOwner.activate();
    let wasReady = browserOwner.isReady(shopperId);
    const unsubscribe = browserOwner.subscribe(() => {
      const ready = browserOwner.isReady(shopperId);
      if (wasReady && !ready) {
        sessionBarrier.beginReset({ requiresBrowserSignOut: Platform.OS !== 'web' });
        settleSignInWaiters(false);
      }
      wasReady = ready;
    });
    return () => {
      unsubscribe();
      browserOwner.deactivate();
      sessionBarrier.beginReset({ requiresBrowserSignOut: Platform.OS !== 'web' });
      settleSignInWaiters(false);
    };
  }, [browserOwner, sessionBarrier, settleSignInWaiters, shopperId]);

  const notifyPageReady = useCallback(
    (url: string, signedIn: boolean, nextChallenge: AmazonAuthChallenge) => {
      if (url) {
        setCurrentUrl(url);
        currentUrlRef.current = url;
      }
      const effectiveSignedIn = !ownerIsReady() || sessionBarrier.isLogoutPending ? false : signedIn;
      const effectiveChallenge = sessionBarrier.isLogoutPending && signedIn ? 'signin' : nextChallenge;
      setChallenge(effectiveChallenge);
      challengeRef.current = effectiveChallenge;
      setIsSignedIn(effectiveSignedIn);
      isSignedInRef.current = effectiveSignedIn;
      if (effectiveSignedIn) {
        settleSignInWaiters(true);
      }

      if (pageWaitersRef.current.size > 0) {
        for (const waiter of Array.from(pageWaitersRef.current)) {
          if (waiter.predicate(url)) {
            clearTimeout(waiter.timer);
            pageWaitersRef.current.delete(waiter);
            waiter.resolve({ url, signedIn: effectiveSignedIn, challenge: effectiveChallenge });
          }
        }
      }
    },
    [ownerIsReady, sessionBarrier, settleSignInWaiters],
  );

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(event.nativeEvent.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (!parsed || typeof parsed.type !== 'string') return;

      if (parsed.type === 'PAGE_READY') {
        const url = typeof parsed.url === 'string' ? parsed.url : '';
        const signedIn = Boolean(parsed.signedIn);
        const ch = (parsed.challenge as AmazonAuthChallenge) ?? 'none';
        notifyPageReady(url, signedIn, ch);
        return;
      }

      if (parsed.type === 'STEP_RESULT' && typeof parsed.reqId === 'string') {
        const pending = stepResolversRef.current.get(parsed.reqId);
        if (!pending) return;
        clearTimeout(pending.timer);
        stepResolversRef.current.delete(parsed.reqId);
        if (parsed.ok) {
          pending.resolve(parsed.data);
        } else {
          pending.reject(new Error(typeof parsed.error === 'string' ? parsed.error : 'Step failed'));
        }
      }
    },
    [notifyPageReady],
  );

  const handleNavigationStateChange = useCallback((navState: WebViewNavigation) => {
    setIsPageLoading(Boolean(navState.loading));
    canGoBackRef.current = Boolean(navState.canGoBack);
    if (navState.url) {
      setCurrentUrl(navState.url);
      currentUrlRef.current = navState.url;
    }
  }, []);

  const handleLoadEnd = useCallback(() => {
    setIsPageLoading(false);
    webViewRef.current?.injectJavaScript(AMAZON_PAGE_BOOTSTRAP_JS);
  }, []);

  const evalStep = useCallback(<T,>(buildScript: (reqId: string) => string, timeoutMs = 12_000): Promise<T> => {
    if (Platform.OS === 'web' || !webViewRef.current) {
      return Promise.reject(new Error('Persistent WKWebView requires an iOS or Android runtime.'));
    }
    reqSeqRef.current += 1;
    const reqId = `amz-req-${Date.now()}-${reqSeqRef.current}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        stepResolversRef.current.delete(reqId);
        reject(new Error(`Timed out waiting for Amazon WebView response (${reqId}).`));
      }, timeoutMs);
      stepResolversRef.current.set(reqId, {
        resolve: (val) => resolve(val as T),
        reject,
        timer,
      });
      webViewRef.current?.injectJavaScript(buildScript(reqId));
    });
  }, []);

  const waitForNextPageReady = useCallback(
    (predicate: (url: string) => boolean = () => true, timeoutMs = 15_000) => {
      return new Promise<{ url: string; signedIn: boolean; challenge: AmazonAuthChallenge }>(
        (resolve) => {
          const waiter: PendingPageReadyWaiter = {
            predicate,
            resolve,
            timer: setTimeout(() => {
              pageWaitersRef.current.delete(waiter);
              resolve({
                url: currentUrlRef.current,
                signedIn: isSignedInRef.current,
                challenge: 'none',
              });
            }, timeoutMs),
          };
          pageWaitersRef.current.add(waiter);
        },
      );
    },
    [],
  );

  const navigateTo = useCallback(
    async (targetUrl: string, timeoutMs = 16_000) => {
      if (Platform.OS === 'web' || !webViewRef.current) return;
      const waitPromise = waitForNextPageReady((u) => u.startsWith('http'), timeoutMs);
      webViewRef.current.injectJavaScript(
        `window.location.assign(${JSON.stringify(targetUrl)}); true;`,
      );
      await waitPromise;
      await delay(750);
    },
    [waitForNextPageReady],
  );

  const enqueueCommand = useCallback(<T,>(task: () => Promise<T>, ownershipReset = false): Promise<T> => {
    setBusyCount((c) => c + 1);
    const fenced = () => {
      if (!ownershipReset && !ownerIsReady()) throw new Error('Amazon browser ownership is not verified. Reconnect Amazon.');
      return task();
    };
    const next = commandQueueRef.current.then(fenced, fenced);
    commandQueueRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      setBusyCount((c) => Math.max(0, c - 1));
    });
  }, [ownerIsReady]);

  const applyEmptySessionState = useCallback(() => {
    const empty = resetAmazonSessionStores({
      ledger: submissionLedgerRef.current,
      syncQueue,
      idempotencyMap: idempotencyMapRef.current,
      productCache: productCacheRef.current,
    });
    knownConvexOrderRefByRetailerIdRef.current.clear();
    void syncedCartLedger.reset(shopperId);
    void ownedCartSync.reset(shopperId ?? null);

    setIsSignedIn(empty.isSignedIn);
    isSignedInRef.current = empty.isSignedIn;
    setChallenge(empty.challenge);
    challengeRef.current = empty.challenge;
    setItems(empty.items);
    itemsRef.current = empty.items;
    setPurchases(empty.purchases);
    purchasesRef.current = empty.purchases;
    setPurchasedItems(empty.purchasedItems);
    purchasedItemsRef.current = empty.purchasedItems;
    setPendingRequests(empty.pendingRequests);
    pendingRequestsRef.current = empty.pendingRequests;
    setLastSyncedAt(empty.lastSyncedAt);
    lastSyncedAtRef.current = empty.lastSyncedAt;
    setLastSyncError(empty.lastSyncError);
    setPendingSyncCount(empty.pendingSyncCount);
  }, [ownedCartSync, shopperId, syncQueue, syncedCartLedger]);

  const runVerifiedBrowserLogout = useCallback(
    async (targetEpoch: number): Promise<void> => {
      applyEmptySessionState();

      const nativeView = webViewRef.current as unknown as {
        clearCache?: (includeDiskFiles: boolean) => void;
        clearHistory?: () => void;
      } | null;
      nativeView?.clearCache?.(true);
      nativeView?.clearHistory?.();

      if (Platform.OS === 'web') {
        return;
      }

      if (!webViewRef.current) {
        const msg =
          'Amazon WebView is not mounted yet to complete sign-out; session remains locked until sign-out succeeds.';
        setLastSyncError(msg);
        throw new Error(msg);
      }

      await evalStep((reqId) => buildClearWebViewSessionScript(reqId), 6_000).catch(
        () => undefined,
      );
      await navigateTo(AMAZON_SIGNOUT_URL, 10_000);
      await evalStep((reqId) => buildClearWebViewSessionScript(reqId), 6_000).catch(
        () => undefined,
      );
      await navigateTo(AMAZON_CART_URL, 10_000);

      let probe: AmazonSessionCheckResult | null = null;
      try {
        probe = await evalStep<AmazonSessionCheckResult>(
          (reqId) => buildSessionCheckScript(reqId),
          10_000,
        );
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const msg = `Amazon sign-out verification failed (${detail}). Session remains locked until sign-out succeeds.`;
        setLastSyncError(msg);
        throw new Error(msg);
      }

      const verdict = sessionBarrier.verifySignOutResult(targetEpoch, probe);
      if (!verdict.ok) {
        setIsSignedIn(false);
        isSignedInRef.current = false;
        setLastSyncError(verdict.reason);
        throw new Error(verdict.reason);
      }

      await navigateTo(AMAZON_SIGNIN_URL, 10_000).catch(() => undefined);
      if (sessionBarrier.epoch === targetEpoch) {
        setIsSignedIn(false);
        isSignedInRef.current = false;
        setChallenge('signin');
        challengeRef.current = 'signin';
        setCurrentUrl(AMAZON_SIGNIN_URL);
        currentUrlRef.current = AMAZON_SIGNIN_URL;
        setLastSyncError(null);
      }
    },
    [applyEmptySessionState, evalStep, navigateTo, sessionBarrier],
  );

  const ensureReadySessionEpoch = useCallback(
    async (expectedEpoch?: number): Promise<number> => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      if (sessionBarrier.isLogoutPending) {
        await runVerifiedBrowserLogout(sessionBarrier.epoch);
      }
      if (expectedEpoch !== undefined && !sessionBarrier.isCurrent(expectedEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      return sessionBarrier.epoch;
    },
    [ownerIsReady, runVerifiedBrowserLogout, sessionBarrier],
  );

  const syncCartRowsToState = useCallback(
    (rows: ScrapedAmazonCartRow[], syncedAt: number, expectedEpoch?: number): CartItem[] => {
      if (
        sessionBarrier.isLogoutPending ||
        (expectedEpoch !== undefined && !sessionBarrier.isCurrent(expectedEpoch))
      ) {
        return [];
      }
      const existingByAsin = new Map<string, CartItem>();
      for (const item of itemsRef.current) {
        const asin = extractAsin(item.url);
        if (asin) existingByAsin.set(asin, item);
      }
      const nextItems = rows.map((row) =>
        buildCartItemFromScrapedRow(
          row,
          productCacheRef.current.get(row.asin.toUpperCase()),
          existingByAsin.get(row.asin.toUpperCase()),
          syncedAt,
        ),
      );
      setItems(nextItems);
      itemsRef.current = nextItems;
      setLastSyncedAt(syncedAt);
      lastSyncedAtRef.current = syncedAt;
      return nextItems;
    },
    [sessionBarrier],
  );

  const flushPendingSync = useCallback(() => {
    if (!ownerIsReady() || sessionBarrier.isLogoutPending) {
      return Promise.resolve({
        synced: 0,
        remaining: syncQueue.pendingCount,
        lastSyncError: 'Amazon sign-out verification is pending.',
      });
    }
    return syncQueue.flush(convexSyncRef.current);
  }, [ownerIsReady, sessionBarrier, syncQueue]);

  const resetBrowserSession = useCallback(async (): Promise<void> => {
    const resetEpoch = sessionBarrier.beginReset({
      requiresBrowserSignOut: Platform.OS !== 'web',
    });
    setIsSheetOpen(false);
    settleSignInWaiters(false);
    applyEmptySessionState();

    await enqueueCommand(async () => {
      if (sessionBarrier.epoch !== resetEpoch) {
        return;
      }
      await runVerifiedBrowserLogout(resetEpoch);
    }, true);
  }, [applyEmptySessionState, enqueueCommand, runVerifiedBrowserLogout, sessionBarrier, settleSignInWaiters]);

  const resetSession = useCallback(async (): Promise<void> => {
    const ready = await browserOwner.initialize(shopperId, resetBrowserSession, true);
    if (!ready) throw new Error('Amazon ownership could not be verified. Reconnect Amazon.');
  }, [browserOwner, resetBrowserSession, shopperId]);

  useEffect(() => {
    let cancelled = false;
    void browserOwner.initialize(shopperId, resetBrowserSession, sessionBarrier.isLogoutPending).then((ready) => {
      if (!cancelled) {
        if (!ready) setLastSyncError('Amazon ownership could not be verified. Reconnect Amazon.');
      }
    });
    return () => { cancelled = true; browserOwner.invalidate(); };
  }, [browserOwner, resetBrowserSession, sessionBarrier, shopperId]);

  const openBrowserSheet = useCallback(
    (initialUrl?: string) => {
      if (!ownerIsReady()) {
        void resetSession()
          .then(() => setIsSheetOpen(true))
          .catch(() => settleSignInWaiters(false));
        return;
      }
      const reveal = () => {
        setIsSheetOpen(true);
        if (initialUrl && webViewRef.current) {
          webViewRef.current.injectJavaScript(
            `window.location.assign(${JSON.stringify(initialUrl)}); true;`,
          );
        } else if (
          webViewRef.current &&
          shouldStartFreshSignInNavigation({
            initialUrl,
            isSignedIn: isSignedInRef.current,
            currentUrl: currentUrlRef.current,
            challenge: challengeRef.current,
          })
        ) {
          webViewRef.current.injectJavaScript(
            `window.location.assign(${JSON.stringify(AMAZON_SIGNIN_URL)}); true;`,
          );
        }
      };

      if (sessionBarrier.isLogoutPending) {
        void enqueueCommand(async () => {
          await runVerifiedBrowserLogout(sessionBarrier.epoch);
        })
          .then(reveal)
          .catch(() => {
            setIsSheetOpen(false);
          });
        return;
      }

      reveal();
    },
    [enqueueCommand, ownerIsReady, resetSession, runVerifiedBrowserLogout, sessionBarrier, settleSignInWaiters],
  );

  const closeBrowserSheet = useCallback(() => {
    setIsSheetOpen(false);
    settleSignInWaiters(false);
  }, [settleSignInWaiters]);

  const checkSession = useCallback((): Promise<AmazonSessionCheckResult> => {
    const callerEpoch = sessionBarrier.epoch;
    return enqueueCommand(async () => {
      const opEpoch = await ensureReadySessionEpoch(
        sessionBarrier.isLogoutPending ? undefined : callerEpoch,
      );
      if (!currentUrlRef.current.includes('amazon.com')) {
        await navigateTo(AMAZON_CART_URL);
      }
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      const res = await evalStep<AmazonSessionCheckResult>((reqId) => buildSessionCheckScript(reqId));
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      setIsSignedIn(res.signedIn);
      isSignedInRef.current = res.signedIn;
      setChallenge(res.challenge);
      challengeRef.current = res.challenge;
      setLastSyncedAt(res.checkedAt);
      lastSyncedAtRef.current = res.checkedAt;
      lastHeartbeatAtRef.current = res.checkedAt;
      return res;
    });
  }, [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, sessionBarrier]);

  const ensureSignedIn = useCallback(async (): Promise<boolean> => {
    const check = await checkSession();
    if (!ownerIsReady()) return false;
    if (check.signedIn) return true;

    return new Promise<boolean>((resolve) => {
      signInWaitersRef.current.add(resolve);
      // Preserve active MFA/CVF/CAPTCHA or existing /ap/signin challenge if already active
      openBrowserSheet();
    });
  }, [checkSession, openBrowserSheet, ownerIsReady]);

  const runAddToCartUnlocked = useCallback(
    async (input: AmazonAddToCartInput, opEpoch: number): Promise<AmazonAddToCartResult> => {
      const requestedQty = Math.max(1, Math.min(10, Math.floor(input.quantity ?? 1)));
      let asin = extractAsin(input.asin ?? input.url);

      if (!asin && input.url && isAmazonShortLink(input.url)) {
        await navigateTo(input.url);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const resolved = await evalStep<{ asin: string | null; url: string }>((reqId) =>
          buildResolvePageAsinScript(reqId),
        );
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        asin = resolved.asin;
      }

      if (!asin) {
        throw new Error('Could not extract a 10-character Amazon ASIN from the provided URL.');
      }

      await navigateTo(canonicalAmazonProductUrl(asin));
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      const productAttempt = await evalStep<{
        status: 'captcha' | 'needs_aod_fallback' | 'clicked_primary';
        productMeta?: {
          title: string;
          unitPriceCents: number | null;
          listPriceCents: number | null;
          imageUrl: string | null;
          deliveryEstimate: string;
          seller: string;
          rating: { average: number; count: number } | null;
        };
      }>((reqId) => buildProductScrapeAndAddScript(reqId, requestedQty));

      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }

      if (productAttempt.status === 'captcha') {
        setChallenge('captcha');
        challengeRef.current = 'captcha';
        return {
          ok: false,
          asin,
          usedAodFallback: false,
          cartCount: 0,
          subtotalCents: 0,
          addedItem: null,
          cartRows: [],
          syncedAt: Date.now(),
          error: 'Amazon requested CAPTCHA verification. Open the Amazon Browser sheet to continue.',
        };
      }

      if (productAttempt.productMeta) {
        productCacheRef.current.set(asin, {
          asin,
          title: productAttempt.productMeta.title,
          unitPriceCents: productAttempt.productMeta.unitPriceCents,
          listPriceCents: productAttempt.productMeta.listPriceCents,
          imageUrl: productAttempt.productMeta.imageUrl,
          deliveryEstimate: productAttempt.productMeta.deliveryEstimate,
          seller: productAttempt.productMeta.seller,
          variantLabel: input.variantLabel ?? 'Standard',
          rating: productAttempt.productMeta.rating,
        });
      }

      let usedAodFallback = false;
      let aodAppliedQuantity = true;
      if (productAttempt.status === 'needs_aod_fallback') {
        usedAodFallback = true;
        await navigateTo(amazonOfferListingUrl(asin));
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const aodRes = await evalStep<{
          clicked: boolean;
          appliedQuantity: boolean;
          seller: string | null;
          priceCents: number | null;
        }>((reqId) => buildAodAddToCartScript(reqId, requestedQty), 14_000);

        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }

        if (!aodRes.clicked) {
          return {
            ok: false,
            asin,
            usedAodFallback: true,
            cartCount: 0,
            subtotalCents: 0,
            addedItem: null,
            cartRows: [],
            syncedAt: Date.now(),
            error: `No active Add to Cart offer found on Amazon for ASIN ${asin}.`,
          };
        }

        aodAppliedQuantity = aodRes.appliedQuantity;
        const cached = productCacheRef.current.get(asin);
        if (cached) {
          productCacheRef.current.set(asin, {
            ...cached,
            seller: aodRes.seller ?? cached.seller,
            unitPriceCents: aodRes.priceCents ?? cached.unitPriceCents,
          });
        }
      }

      await delay(2200);
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      await navigateTo(AMAZON_CART_URL);
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }

      let scrapedCart = await evalStep<{
        signedIn: boolean;
        challenge: AmazonAuthChallenge;
        currentUrl: string;
        cartCount: number;
        subtotalCents: number;
        items: ScrapedAmazonCartRow[];
      }>((reqId) => buildScrapeCartScript(reqId));

      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }

      // When AOD fallback added a single-unit offer without an in-form quantity selector,
      // step the cart row up to requestedQty on /gp/cart/view.html and re-verify.
      if (usedAodFallback && !aodAppliedQuantity && requestedQty > 1) {
        const livePlan = computeLiveCartQuantityPlan(scrapedCart.items, asin, requestedQty);
        if (livePlan.found && livePlan.operation === 'increment' && livePlan.steps > 0) {
          for (let i = 0; i < livePlan.steps; i += 1) {
            if (!sessionBarrier.isCurrent(opEpoch)) {
              throw new Error('Amazon session was reset.');
            }
            const mutRes = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
              buildMutateCartRowScript(reqId, asin!, 'increment'),
            );
            if (!mutRes.mutated) break;
            await delay(1100);
          }
          if (!sessionBarrier.isCurrent(opEpoch)) {
            throw new Error('Amazon session was reset.');
          }
          scrapedCart = await evalStep<{
            signedIn: boolean;
            challenge: AmazonAuthChallenge;
            currentUrl: string;
            cartCount: number;
            subtotalCents: number;
            items: ScrapedAmazonCartRow[];
          }>((reqId) => buildScrapeCartScript(reqId));
        }
      }

      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }

      setIsSignedIn(scrapedCart.signedIn);
      isSignedInRef.current = scrapedCart.signedIn;
      setChallenge(scrapedCart.challenge);
      challengeRef.current = scrapedCart.challenge;

      const syncedAt = Date.now();
      lastHeartbeatAtRef.current = syncedAt;
      const nextItems = syncCartRowsToState(scrapedCart.items, syncedAt, opEpoch);
      const addedItem = selectVerifiedAddedCartItem(nextItems, asin, requestedQty);

      if (!addedItem) {
        return {
          ok: false,
          asin,
          usedAodFallback,
          cartCount: scrapedCart.cartCount,
          subtotalCents: scrapedCart.subtotalCents,
          addedItem: null,
          cartRows: scrapedCart.items,
          syncedAt,
          error: `Amazon cart did not reflect ASIN ${asin} at requested quantity (${requestedQty}).`,
        };
      }

      return {
        ok: true,
        asin,
        usedAodFallback,
        cartCount: scrapedCart.cartCount,
        subtotalCents: scrapedCart.subtotalCents,
        addedItem,
        cartRows: scrapedCart.items,
        syncedAt,
      };
    },
    [evalStep, navigateTo, sessionBarrier, syncCartRowsToState],
  );

  const addToCart = useCallback(
    (input: AmazonAddToCartInput): Promise<AmazonAddToCartResult> => {
      const callerEpoch = sessionBarrier.epoch;
      return enqueueCommand(async () => {
        const opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
        return runAddToCartUnlocked(input, opEpoch);
      });
    },
    [enqueueCommand, ensureReadySessionEpoch, runAddToCartUnlocked, sessionBarrier],
  );

  const getCheckoutQuote = useCallback(
    (input: AmazonCheckoutQuoteInput = {}): Promise<AmazonCheckoutQuoteResult> => {
      const effectiveDryRun = input.dryRun ?? true;
      const callerEpoch = sessionBarrier.epoch;

      return enqueueCommand(async () => {
        const opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
        await navigateTo(AMAZON_CART_URL);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const cartSnap = await evalStep<{
          signedIn: boolean;
          challenge: AmazonAuthChallenge;
          currentUrl: string;
          cartCount: number;
          subtotalCents: number;
          items: ScrapedAmazonCartRow[];
        }>((reqId) => buildScrapeCartScript(reqId));

        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }

        const now = Date.now();
        const syncedItems = syncCartRowsToState(cartSnap.items, now, opEpoch);

        if (cartSnap.items.length === 0) {
          return {
            ok: false,
            dryRun: effectiveDryRun,
            requiresSignIn: !cartSnap.signedIn,
            haltedAt: 'cart_empty',
            canPlaceOrder: false,
            liveTotalVerified: false,
            basketBound: false,
            approvedItems: [],
            quote: null,
            currentUrl: cartSnap.currentUrl,
            quotedAt: now,
            error: 'Amazon cart is empty. Add an item before requesting a checkout quote.',
          };
        }

        const hasExplicitTarget = Boolean(
          (input.approvedItems && input.approvedItems.length > 0) || input.asin,
        );

        // Live order placement (`dryRun === false`) ALWAYS requires explicit ASIN + quantity binding.
        const effectiveApprovedSpec: ApprovedBasketItem[] | undefined = hasExplicitTarget
          ? undefined
          : effectiveDryRun
            ? cartSnap.items.map((r) => ({ asin: r.asin, quantity: r.quantity }))
            : [];

        const basketCheck = verifyActiveBasketBinding(cartSnap.items, {
          asin: extractAsin(input.asin),
          quantity: input.quantity,
          approvedItems: input.approvedItems ?? effectiveApprovedSpec,
          navCartCount: cartSnap.cartCount,
        });

        if (!basketCheck.ok) {
          return {
            ok: false,
            dryRun: effectiveDryRun,
            requiresSignIn: !cartSnap.signedIn,
            haltedAt: 'basket_mismatch',
            canPlaceOrder: false,
            liveTotalVerified: false,
            basketBound: false,
            approvedItems: [],
            quote: null,
            currentUrl: cartSnap.currentUrl,
            quotedAt: now,
            error: basketCheck.reason,
          };
        }

        const boundApprovedItems = basketCheck.approvedItems;
        const primaryAsin = boundApprovedItems[0]?.asin;
        const targetItem =
          syncedItems.find((item) => extractAsin(item.url) === primaryAsin) ?? syncedItems[0]!;
        const totalApprovedQty = boundApprovedItems.reduce((sum, item) => sum + item.quantity, 0);

        const navWait = waitForNextPageReady(() => true, 12_000);
        const ptc = await evalStep<{ clicked: boolean; currentUrl: string }>((reqId) =>
          buildClickProceedToCheckoutScript(reqId),
        );

        if (ptc.clicked) {
          await navWait;
          await delay(1200);
        }

        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }

        const review = await evalStep<{
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
        }>((reqId) => buildInspectCheckoutReviewScript(reqId));

        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }

        const quotedAt = Date.now();
        setLastSyncedAt(quotedAt);
        lastSyncedAtRef.current = quotedAt;

        const activeSubtotalCents = basketCheck.matchedRows.reduce(
          (sum, r) => sum + r.unitPriceCents * r.quantity,
          0,
        );
        const unitPriceCents =
          boundApprovedItems.length === 1
            ? basketCheck.matchedRows[0]?.unitPriceCents ?? 0
            : Math.round(activeSubtotalCents / Math.max(1, totalApprovedQty));
        const fallbackTax = Math.round(activeSubtotalCents * ESTIMATED_TAX_RATE);

        if (review.stage === 'signin_gate' || review.stage === 'captcha_gate') {
          setIsSignedIn(false);
          isSignedInRef.current = false;
          const gateChallenge = review.stage === 'captcha_gate' ? 'captcha' : 'signin';
          setChallenge(gateChallenge);
          challengeRef.current = gateChallenge;

          const preAuthQuote: Quote = {
            retailer: 'amazon',
            retailerName: 'Amazon',
            seller: targetItem.offer?.seller ?? 'Amazon.com',
            productTitle:
              boundApprovedItems.length > 1
                ? `${targetItem.product?.title ?? 'Amazon Item'} (+${boundApprovedItems.length - 1} more)`
                : targetItem.product?.title ?? 'Amazon Item',
            variantLabel: targetItem.variant?.label ?? null,
            imageUrl: targetItem.product?.imageUrl ?? null,
            quantity: totalApprovedQty,
            unitPriceCents,
            subtotalCents: activeSubtotalCents,
            taxCents: fallbackTax,
            shippingCents: 0,
            totalCents: activeSubtotalCents + fallbackTax,
            currency: 'USD',
            deliveryEstimate:
              targetItem.offer?.deliveryEstimate ?? 'Sign in to confirm exact Amazon delivery date',
            returnSummary: targetItem.offer?.returnSummary ?? '30-day Amazon return policy',
            quotedAt,
            simulated: false,
          };

          return {
            ok: true,
            dryRun: true,
            requiresSignIn: true,
            haltedAt: review.stage,
            canPlaceOrder: false,
            liveTotalVerified: false,
            basketBound: true,
            approvedItems: boundApprovedItems,
            quote: preAuthQuote,
            currentUrl: review.currentUrl,
            quotedAt,
          };
        }

        setIsSignedIn(true);
        isSignedInRef.current = true;
        setChallenge('none');
        challengeRef.current = 'none';

        const reviewBinding = verifyCheckoutReviewBinding({
          approvedItems: boundApprovedItems,
          summaryItemCount: review.summaryItemCount,
          lineItems: review.lineItems,
        });

        if (!reviewBinding.ok) {
          return {
            ok: false,
            dryRun: effectiveDryRun,
            requiresSignIn: false,
            haltedAt: 'basket_mismatch',
            canPlaceOrder: false,
            liveTotalVerified: false,
            basketBound: false,
            approvedItems: boundApprovedItems,
            quote: null,
            currentUrl: review.currentUrl,
            quotedAt,
            error: reviewBinding.reason,
          };
        }

        // Fail closed if the live checkout review screen did not yield a valid positive integer total
        if (!isValidPositiveCents(review.totalCents)) {
          return {
            ok: false,
            dryRun: effectiveDryRun,
            requiresSignIn: false,
            haltedAt: 'total_unverified',
            canPlaceOrder: false,
            liveTotalVerified: false,
            basketBound: true,
            approvedItems: boundApprovedItems,
            quote: null,
            currentUrl: review.currentUrl,
            quotedAt,
            error:
              'Fail-closed: live checkout grand total could not be parsed on the Amazon checkout review screen.',
          };
        }

        const totalCents = review.totalCents;
        const subtotalCents = isValidPositiveCents(review.subtotalCents)
          ? review.subtotalCents
          : activeSubtotalCents;
        const shippingCents = review.shippingCents ?? 0;
        const taxCents =
          typeof review.taxCents === 'number' && review.taxCents >= 0
            ? review.taxCents
            : Math.max(0, totalCents - subtotalCents - shippingCents);

        const verifiedQuote: Quote = {
          retailer: 'amazon',
          retailerName: 'Amazon',
          seller: targetItem.offer?.seller ?? 'Amazon.com',
          productTitle: targetItem.product?.title ?? 'Amazon Item',
          variantLabel: targetItem.variant?.label ?? null,
          imageUrl: targetItem.product?.imageUrl ?? null,
          quantity: totalApprovedQty,
          unitPriceCents,
          subtotalCents,
          taxCents,
          shippingCents,
          totalCents,
          currency: 'USD',
          deliveryEstimate:
            review.deliveryEstimate ?? targetItem.offer?.deliveryEstimate ?? 'Amazon delivery',
          returnSummary: targetItem.offer?.returnSummary ?? '30-day Amazon return policy',
          quotedAt,
          simulated: false,
        };

        return {
          ok: true,
          dryRun: effectiveDryRun,
          requiresSignIn: false,
          haltedAt: 'checkout_review',
          canPlaceOrder: review.canPlaceOrder,
          liveTotalVerified: true,
          basketBound: true,
          approvedItems: boundApprovedItems,
          quote: verifiedQuote,
          currentUrl: review.currentUrl,
          quotedAt,
        };
      });
    },
    [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, sessionBarrier, syncCartRowsToState, waitForNextPageReady],
  );

  const placeOrder = useCallback(
    async (input: AmazonPlaceOrderInput): Promise<AmazonPlaceOrderResult> => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      const dryRun = input.dryRun ?? true;
      const userConfirmed = input.userConfirmed ?? false;
      const orderRef = input.orderRef ?? `CART-${Date.now().toString(36).toUpperCase()}`;
      if (!AMAZON_LIVE_SUBMISSION_ENABLED && dryRun === false) {
        return {
          status: 'safety_blocked',
          safetyGate: { dryRun, userConfirmed, orderSubmitted: false },
          orderRef, retailerOrderId: null, placedAt: null, quote: null, shipment: null,
          reason: 'Live checkout is release-disabled pending transactional submission claims.',
        };
      }

      if (sessionBarrier.isLogoutPending) {
        try {
          await enqueueCommand(() => runVerifiedBrowserLogout(sessionBarrier.epoch));
        } catch (err) {
          return {
            status: 'safety_blocked',
            safetyGate: { dryRun, userConfirmed, orderSubmitted: false },
            orderRef,
            retailerOrderId: null,
            placedAt: null,
            quote: null,
            shipment: null,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }

      const startEpoch = sessionBarrier.epoch;

      // 1. Reconcile-before-retry ledger check: never double-submit `'placed'` OR `'unknown'` orderRef
      const ledgerEntry = submissionLedgerRef.current.get(orderRef);
      if (ledgerEntry?.state === 'placed') {
        const replaySync = await syncQueue.flush(convexSyncRef.current);
        return {
          status: 'placed',
          safetyGate: { dryRun, userConfirmed, orderSubmitted: false },
          orderRef,
          retailerOrderId: ledgerEntry.retailerOrderId,
          placedAt: ledgerEntry.placedAt,
          quote: null,
          shipment: null,
          reason: 'Idempotent replay: returning existing placed order.',
          syncError: replaySync.lastSyncError,
        };
      }
      if (ledgerEntry?.state === 'unknown') {
        return {
          status: 'unknown',
          safetyGate: { dryRun, userConfirmed, orderSubmitted: false },
          orderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: null,
          shipment: null,
          reason:
            'Previous submission for this orderRef had an unconfirmed outcome; reconcile via syncOrders() before retrying.',
          syncError: syncQueue.lastSyncError,
        };
      }

      // 2. HARD SAFETY GATE (Host Level): Never click Place Order unless dryRun === false && userConfirmed === true
      if (dryRun !== false || userConfirmed !== true) {
        const quoteResult = await getCheckoutQuote({
          asin: input.asin,
          quantity: input.quantity,
          approvedItems: input.approvedItems,
          dryRun: true,
        });
        return {
          status: 'dry_run_halted',
          safetyGate: {
            dryRun: true,
            userConfirmed,
            orderSubmitted: false,
          },
          orderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: quoteResult.quote,
          shipment: null,
          reason: quoteResult.requiresSignIn
            ? 'Halted by dryRun safety gate at Amazon Sign-In (/ap/signin). Place Order was never invoked.'
            : 'Halted by dryRun safety gate on checkout review. Place Order was never invoked.',
        };
      }

      // 3. Fail-closed pre-flight validation of expectedTotalCents & approved basket BEFORE WebView checkout
      const expectedCents =
        input.expectedTotalCents ??
        (typeof input.expectedTotal === 'number' && Number.isFinite(input.expectedTotal)
          ? Math.round(input.expectedTotal * 100)
          : undefined);

      if (!isValidPositiveCents(expectedCents)) {
        return {
          status: 'safety_blocked',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: null,
          shipment: null,
          reason:
            'Fail-closed: expectedTotalCents must be a positive finite integer before live order placement.',
        };
      }

      const normalizedSpec = normalizeApprovedItems({
        asin: extractAsin(input.asin),
        quantity: input.quantity,
        approvedItems: input.approvedItems,
      });
      if (!normalizedSpec.ok) {
        return {
          status: 'safety_blocked',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: null,
          shipment: null,
          reason: normalizedSpec.reason,
        };
      }

      // 4. Inspect live cart & checkout review with strict basket + live total verification
      const liveQuoteRes = await getCheckoutQuote({
        approvedItems: normalizedSpec.items,
        dryRun: false,
      });

      const gateDecision = evaluatePreSubmitSafetyGate({
        dryRun: false,
        userConfirmed: true,
        approvedItems: normalizedSpec.items,
        expectedTotalCents: expectedCents,
        requiresSignIn: liveQuoteRes.requiresSignIn,
        basketBound: liveQuoteRes.basketBound && liveQuoteRes.haltedAt !== 'basket_mismatch',
        basketBindingReason: liveQuoteRes.error,
        checkoutReviewBound: liveQuoteRes.basketBound && liveQuoteRes.haltedAt === 'checkout_review',
        checkoutReviewReason: liveQuoteRes.error,
        liveTotalVerified: liveQuoteRes.liveTotalVerified,
        liveTotalCents: liveQuoteRes.quote?.totalCents,
      });

      if (!gateDecision.allowSubmit || !liveQuoteRes.quote) {
        return {
          status: gateDecision.allowSubmit ? 'safety_blocked' : gateDecision.status,
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
          orderRef,
          retailerOrderId: null,
          placedAt: null,
          quote: liveQuoteRes.quote,
          shipment: null,
          reason: gateDecision.allowSubmit ? liveQuoteRes.error : gateDecision.reason,
        };
      }

      const verifiedQuote = liveQuoteRes.quote;

      // 5. Execute in-DOM guarded Place Order click and verify real order confirmation
      return enqueueCommand(async () => {
        if (!sessionBarrier.isCurrent(startEpoch)) {
          return {
            status: 'safety_blocked',
            safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
            orderRef,
            retailerOrderId: null,
            placedAt: null,
            quote: verifiedQuote,
            shipment: null,
            reason: 'Fail-closed: Amazon session was reset before Place Order could execute.',
          };
        }

        const submitTimestamp = Date.now();
        if (!await submissionClaims.claim(shopperId, orderRef, submitTimestamp) || !sessionBarrier.isCurrent(startEpoch)) {
          return {
            status: 'unknown', safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: false },
            orderRef, retailerOrderId: null, placedAt: null, quote: verifiedQuote, shipment: null,
            reason: 'Durable submission intent exists or storage is unavailable; manual reconciliation required.',
          };
        }
        submissionLedgerRef.current.recordUnknown({
          orderRef, submittedAt: submitTimestamp,
          approvedItems: gateDecision.approvedItems,
          expectedTotalCents: gateDecision.expectedTotalCents,
        });
        const navWait = waitForNextPageReady(() => true, 18_000);
        const submitRes = await evalStep<{
          submitted: boolean;
          haltedBySafetyGate: boolean;
          code?: string;
          reason?: string;
        }>((reqId) =>
          buildSubmitCheckoutOrderScript(reqId, {
            dryRun: false,
            userConfirmed: true,
            expectedTotalCents: gateDecision.expectedTotalCents,
            approvedItems: gateDecision.approvedItems,
          }),
        ).catch(() => null);

        if (!submitRes) {
          return {
            status: 'unknown', safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
            orderRef, retailerOrderId: null, placedAt: null, quote: verifiedQuote, shipment: null,
            reason: 'Submission acknowledgement was lost; durable intent remains blocked.',
          };
        }

        if (!submitRes.submitted) {
          const blockedStatus: PlaceOrderExecutionStatus =
            !submitRes.haltedBySafetyGate
              ? 'unknown'
              : submitRes.code === 'requote_required'
              ? 'requote_required'
              : submitRes.code === 'basket_mismatch'
                ? 'basket_mismatch'
                : submitRes.haltedBySafetyGate
                  ? 'safety_blocked'
                  : 'failed';
          return {
            status: blockedStatus,
            safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: !submitRes.haltedBySafetyGate },
            orderRef,
            retailerOrderId: null,
            placedAt: null,
            quote: verifiedQuote,
            shipment: null,
            reason: submitRes.reason,
          };
        }

        const preExistingOrderIds = purchasesRef.current
          .map((p) => p.retailerOrderId)
          .filter((id): id is string => Boolean(id));

        const settled = await settleSubmittedOrderConfirmation({
          orderRef,
          submittedAt: submitTimestamp,
          approvedItems: gateDecision.approvedItems,
          expectedTotalCents: gateDecision.expectedTotalCents,
          preExistingOrderIds,
          verifiedQuote,
          ledger: submissionLedgerRef.current,
          syncQueue: syncQueue,
          convexSync: convexSyncRef.current,
          isSessionCurrent: () => sessionBarrier.isCurrent(startEpoch),
          readConfirmation: async () => {
            await navWait;
            await delay(1500);
            if (!sessionBarrier.isCurrent(startEpoch)) {
              throw new Error('Amazon session was reset during order confirmation.');
            }
            return evalStep<{
              retailerOrderId: string | null;
              isConfirmationSurface?: boolean;
              hasAuthOrErrorBarrier?: boolean;
              currentUrl: string;
            }>((reqId) => buildScrapeOrderConfirmationScript(reqId));
          },
        });

        if (sessionBarrier.isCurrent(startEpoch)) {
          const checkedAt = Date.now();
          setLastSyncedAt(checkedAt);
          lastSyncedAtRef.current = checkedAt;
        }
        return settled;
      });
    },
    [enqueueCommand, evalStep, getCheckoutQuote, runVerifiedBrowserLogout, ownerIsReady, sessionBarrier, shopperId, submissionClaims, syncQueue, waitForNextPageReady],
  );

  const runSyncOrdersUnlocked = useCallback(
    async (opEpoch: number): Promise<AmazonSyncOrdersResult> => {
      await navigateTo(AMAZON_ORDERS_URL);
      if (!sessionBarrier.isCurrent(opEpoch)) {
        return {
          ok: false,
          requiresSignIn: true,
          purchases: [],
          syncedAt: Date.now(),
          error: 'Amazon session was reset.',
        };
      }
      const scraped = await evalStep<{
        signedIn: boolean;
        challenge: AmazonAuthChallenge;
        currentUrl: string;
        orders: {
          retailerOrderId: string;
          asin: string | null;
          asins?: string[];
          items?: ApprovedBasketItem[];
          placedAtMs?: number | null;
          productTitle: string;
          imageUrl: string | null;
          totalCents: number | null;
          statusHeadline: string;
          trackingUrl: string | null;
        }[];
      }>((reqId) => buildScrapeYourOrdersScript(reqId));

      if (!sessionBarrier.isCurrent(opEpoch)) {
        return {
          ok: false,
          requiresSignIn: true,
          purchases: [],
          syncedAt: Date.now(),
          error: 'Amazon session was reset.',
        };
      }

      const syncedAt = Date.now();

      if (!scraped.signedIn) {
        setLastSyncedAt(syncedAt);
        lastSyncedAtRef.current = syncedAt;
        setIsSignedIn(false);
        isSignedInRef.current = false;
        setChallenge(scraped.challenge);
        challengeRef.current = scraped.challenge;
        const syncFlush = await syncQueue.flush(convexSyncRef.current);
        return {
          ok: false,
          requiresSignIn: true,
          purchases: purchasesRef.current,
          syncedAt,
          error: 'Sign in to Amazon to sync Your Orders and delivery dates.',
          syncError: syncFlush.lastSyncError,
        };
      }

      const trackerDetailsByOrderId = new Map<
        string,
        {
          primaryStatus: string | null;
          carrier: string | null;
          trackingNumber: string | null;
          events: RawScrapedTrackingEvent[];
        }
      >();

      const trackableOrders = scraped.orders.filter((o) => Boolean(o.trackingUrl)).slice(0, 3);
      for (const trackable of trackableOrders) {
        if (!trackable.trackingUrl) continue;
        if (!sessionBarrier.isCurrent(opEpoch)) {
          return {
            ok: false,
            requiresSignIn: true,
            purchases: [],
            syncedAt: Date.now(),
            error: 'Amazon session was reset.',
          };
        }
        await navigateTo(trackable.trackingUrl);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          return {
            ok: false,
            requiresSignIn: true,
            purchases: [],
            syncedAt: Date.now(),
            error: 'Amazon session was reset.',
          };
        }
        const detail = await evalStep<{
          primaryStatus: string | null;
          carrier: string | null;
          trackingNumber: string | null;
          events?: RawScrapedTrackingEvent[];
        }>((reqId) => buildScrapeProgressTrackerScript(reqId));
        if (!sessionBarrier.isCurrent(opEpoch)) {
          return {
            ok: false,
            requiresSignIn: true,
            purchases: [],
            syncedAt: Date.now(),
            error: 'Amazon session was reset.',
          };
        }
        trackerDetailsByOrderId.set(trackable.retailerOrderId, {
          primaryStatus: detail.primaryStatus,
          carrier: detail.carrier,
          trackingNumber: detail.trackingNumber,
          events: detail.events ?? [],
        });
      }

      if (!sessionBarrier.isCurrent(opEpoch)) {
        return {
          ok: false,
          requiresSignIn: true,
          purchases: [],
          syncedAt: Date.now(),
          error: 'Amazon session was reset.',
        };
      }

      setLastSyncedAt(syncedAt);
      lastSyncedAtRef.current = syncedAt;
      setIsSignedIn(true);
      isSignedInRef.current = true;
      setChallenge('none');
      challengeRef.current = 'none';

      // Reconcile any previously `'unknown'` submissions strictly against verified new orders
      const reconciled = submissionLedgerRef.current.reconcileFromSyncedOrders(
        scraped.orders.map((o) => ({
          retailerOrderId: o.retailerOrderId,
          asin: o.asin,
          asins: o.asins,
          items: o.items,
          totalCents: o.totalCents,
          placedAtMs: o.placedAtMs,
          syncedAt,
        })),
      );

      const rawPurchasedMap: Record<string, CartItem> = { ...purchasedItemsRef.current };

      const rawSyncedPurchases: Purchase[] = scraped.orders.map((ord) => {
        const enriched = trackerDetailsByOrderId.get(ord.retailerOrderId) ?? null;
        const effectiveHeadline = enriched?.primaryStatus || ord.statusHeadline;
        const shipmentStatus = normalizeShipmentStatus(effectiveHeadline);
        const eta = parseDeliveryEtaIso(effectiveHeadline, syncedAt);
        const totalCents = ord.totalCents ?? 0;
        const itemId = ord.asin ? `amz-item-${ord.asin}` : `amz-item-${ord.retailerOrderId}`;
        const orderRef = `CART-${ord.retailerOrderId.slice(-8)}`;
        const events = buildShipmentEvents({
          rawEvents: enriched?.events,
          status: shipmentStatus,
          headline: effectiveHeadline,
          placedAt: ord.placedAtMs ?? syncedAt - 3_600_000,
          updatedAt: syncedAt,
        });

        const shipment: Shipment = {
          status: shipmentStatus,
          carrier: enriched?.carrier ?? null,
          trackingNumber: enriched?.trackingNumber ?? null,
          trackingUrl: ord.trackingUrl,
          eta,
          events,
          updatedAt: syncedAt,
          simulated: false,
        };

        rawPurchasedMap[itemId] = {
          id: itemId,
          url: ord.asin ? canonicalAmazonProductUrl(ord.asin) : AMAZON_ORDERS_URL,
          status: 'purchased',
          quantity: 1,
          reason: null,
          addedBy: 'app',
          addedAt: syncedAt,
          enrichmentStatus: 'ready',
          product: {
            id: `amz-prod-${ord.asin ?? ord.retailerOrderId}`,
            title: ord.productTitle,
            brand: ord.productTitle.split(' ')[0] ?? null,
            category: 'Amazon',
            imageUrl: ord.imageUrl,
            description: null,
          },
          variant: null,
          offer: null,
          offers: [],
          rating: null,
          price: null,
          priceHistory: null,
        };

        return {
          orderId: `amz-ord-${ord.retailerOrderId}`,
          orderRef,
          requestId: `amz-req-${ord.retailerOrderId}`,
          itemId,
          status: 'placed',
          retailerOrderId: ord.retailerOrderId,
          placedAt: ord.placedAtMs ?? syncedAt,
          quote: {
            retailer: 'amazon',
            retailerName: 'Amazon',
            seller: 'Amazon.com',
            productTitle: ord.productTitle,
            variantLabel: null,
            imageUrl: ord.imageUrl,
            quantity: 1,
            unitPriceCents: totalCents,
            subtotalCents: totalCents,
            taxCents: 0,
            shippingCents: 0,
            totalCents,
            currency: 'USD',
            deliveryEstimate: effectiveHeadline,
            returnSummary: '30-day Amazon return window',
            quotedAt: syncedAt,
            simulated: false,
          },
          simulated: false,
          shipment,
        };
      });

      const applied = applyLedgerReconciliationsToState({
        reconciled,
        pendingRequests: pendingRequestsRef.current,
        items: itemsRef.current,
        purchasedItems: rawPurchasedMap,
        syncedPurchases: rawSyncedPurchases,
      });

      setPendingRequests(applied.pendingRequests);
      pendingRequestsRef.current = applied.pendingRequests;
      setItems(applied.items);
      itemsRef.current = applied.items;
      setPurchasedItems(applied.purchasedItems);
      purchasedItemsRef.current = applied.purchasedItems;
      setPurchases(applied.purchases);
      purchasesRef.current = applied.purchases;

      for (const placementArgs of applied.placementsToSync) {
        knownConvexOrderRefByRetailerIdRef.current.set(
          placementArgs.retailerOrderId,
          placementArgs.orderRef,
        );
        void syncQueue.enqueuePlacement(placementArgs, convexSyncRef.current);
      }

      for (const purchase of applied.purchases) {
        if (!purchase.retailerOrderId || !purchase.shipment) continue;
        const isSyntheticScrapedOrder = purchase.orderId.startsWith('amz-ord-');
        const canonicalOrderRef = isSyntheticScrapedOrder
          ? knownConvexOrderRefByRetailerIdRef.current.get(purchase.retailerOrderId)
          : purchase.orderRef;
        void syncQueue.enqueueShipment(
          buildSyncClientShipmentArgs({
            orderRef: canonicalOrderRef,
            retailerOrderId: purchase.retailerOrderId,
            shipment: purchase.shipment,
          }),
          convexSyncRef.current,
        );
      }

      const syncFlush = await syncQueue.flush(convexSyncRef.current);
      lastHeartbeatAtRef.current = syncedAt;

      return {
        ok: true,
        requiresSignIn: false,
        purchases: applied.purchases,
        syncedAt,
        syncError: syncFlush.lastSyncError,
      };
    },
    [evalStep, navigateTo, sessionBarrier, syncQueue],
  );

  const syncOrders = useCallback((): Promise<AmazonSyncOrdersResult> => {
    const callerEpoch = sessionBarrier.epoch;
    return enqueueCommand(async () => {
      let opEpoch: number;
      try {
        opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
      } catch (err) {
        return {
          ok: false,
          requiresSignIn: true,
          purchases: [],
          syncedAt: Date.now(),
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return runSyncOrdersUnlocked(opEpoch);
    });
  }, [enqueueCommand, ensureReadySessionEpoch, runSyncOrdersUnlocked, sessionBarrier]);

  const makeUnlockedIsolationDeps = useCallback(
    (getOpEpoch: () => number) => {
      const fencedStep = async <T,>(buildScript: (reqId: string) => string): Promise<T> => {
        const opEpoch = getOpEpoch();
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const result = await evalStep<T>(buildScript);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        return result;
      };
      return {
        navigateToCart: async () => {
          if (!sessionBarrier.isCurrent(getOpEpoch())) {
            throw new Error('Amazon session was reset.');
          }
          await navigateTo(AMAZON_CART_URL);
        },
        scrapeCart: async () => {
          const snap = await fencedStep<CartSnapshotScrape>((reqId) => buildScrapeCartScript(reqId));
          setIsSignedIn(snap.signedIn);
          isSignedInRef.current = snap.signedIn;
          setChallenge(snap.challenge);
          challengeRef.current = snap.challenge;
          return snap;
        },
        moveSavedToCart: (targetAsin: string) =>
          fencedStep<{ mutated: boolean; reason?: string }>((reqId) =>
            buildMoveSavedToCartScript(reqId, targetAsin),
          ),
        addTargetToCart: async (input: AmazonAddToCartInput) => {
          const opEpoch = getOpEpoch();
          if (!sessionBarrier.isCurrent(opEpoch)) {
            throw new Error('Amazon session was reset.');
          }
          const added = await runAddToCartUnlocked(input, opEpoch);
          if (!sessionBarrier.isCurrent(opEpoch)) {
            throw new Error('Amazon session was reset.');
          }
          return added;
        },
        stepRowQuantity: (targetAsin: string, op: 'increment' | 'decrement') =>
          fencedStep<{ mutated: boolean; reason?: string }>((reqId) =>
            buildMutateCartRowScript(reqId, targetAsin, op),
          ),
        saveRowForLater: (extraAsin: string) =>
          fencedStep<{ mutated: boolean; reason?: string }>((reqId) =>
            buildSaveCartRowForLaterScript(reqId, extraAsin),
          ),
        waitMs: delay,
      };
    },
    [evalStep, navigateTo, runAddToCartUnlocked, sessionBarrier],
  );

  const proceedToCheckoutAndInspectUnlocked = useCallback(
    async (opEpoch: number): Promise<SpcReviewInspection> => {
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      const navWait = waitForNextPageReady(() => true, 12_000);
      const ptc = await evalStep<{ clicked: boolean; currentUrl: string }>((reqId) =>
        buildClickProceedToCheckoutScript(reqId),
      );
      if (ptc.clicked) {
        await navWait;
        await delay(1200);
      }
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      const review = await evalStep<SpcReviewInspection>((reqId) =>
        buildInspectCheckoutReviewScript(reqId),
      );
      if (!sessionBarrier.isCurrent(opEpoch)) {
        throw new Error('Amazon session was reset.');
      }
      const now = Date.now();
      lastHeartbeatAtRef.current = now;
      setLastSyncedAt(now);
      lastSyncedAtRef.current = now;
      if (review.stage === 'signin_gate' || review.stage === 'captcha_gate') {
        setIsSignedIn(false);
        isSignedInRef.current = false;
        const ch: AmazonAuthChallenge = review.stage === 'captcha_gate' ? 'captcha' : 'signin';
        setChallenge(ch);
        challengeRef.current = ch;
      } else {
        setIsSignedIn(true);
        isSignedInRef.current = true;
        setChallenge('none');
        challengeRef.current = 'none';
      }
      return review;
    },
    [evalStep, sessionBarrier, waitForNextPageReady],
  );

  const quoteSingleItem = useCallback(
    (params: {
      asin: string;
      url: string;
      quantity: number;
      productTitle?: string;
      seller?: string;
      imageUrl?: string | null;
      variantLabel?: string | null;
      returnSummary?: string;
    }): Promise<AmazonCheckoutQuoteResult> => {
      const callerEpoch = sessionBarrier.epoch;
      return enqueueCommand(async () => {
        const opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
        return quoteIsolatedSingleCartItem({
          ...params,
          isolationDeps: makeUnlockedIsolationDeps(() => opEpoch),
          syncCartRowsToState: (rows, syncedAt) => syncCartRowsToState(rows, syncedAt, opEpoch),
          proceedToCheckoutAndInspect: () => proceedToCheckoutAndInspectUnlocked(opEpoch),
        });
      });
    },
    [
      enqueueCommand,
      ensureReadySessionEpoch,
      makeUnlockedIsolationDeps,
      proceedToCheckoutAndInspectUnlocked,
      sessionBarrier,
      syncCartRowsToState,
    ],
  );

  const checkoutAmazonItem = useCallback(
    async (input: AmazonCheckoutItemInput): Promise<AmazonPlaceOrderResult> => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      if (sessionBarrier.isLogoutPending) {
        await enqueueCommand(() => runVerifiedBrowserLogout(sessionBarrier.epoch));
      }
      const startEpoch = sessionBarrier.epoch;
      let activeEpoch = startEpoch;

      return executeDeterministicItemCheckout({
        input,
        submissionAuthority: {
          available: AMAZON_LIVE_SUBMISSION_ENABLED && ownerIsReady(),
          claim: (orderRef, submittedAt) => submissionClaims.claim(shopperId, orderRef, submittedAt),
        },
        isSignedIn: () => isSignedInRef.current && sessionBarrier.isCurrent(startEpoch),
        ensureSignedIn,
        closeBrowserSheet,
        runExclusive: async <T,>(fn: () => Promise<T>): Promise<T> => {
          checkoutInFlightCountRef.current += 1;
          try {
            return await enqueueCommand(async () => {
              activeEpoch = await ensureReadySessionEpoch(
                sessionBarrier.isLogoutPending ? undefined : startEpoch,
              );
              return fn();
            });
          } finally {
            checkoutInFlightCountRef.current = Math.max(0, checkoutInFlightCountRef.current - 1);
          }
        },
        isolationDeps: makeUnlockedIsolationDeps(() => activeEpoch),
        syncCartRowsToState: (rows, syncedAt) => syncCartRowsToState(rows, syncedAt, activeEpoch),
        proceedToCheckoutAndInspect: () => proceedToCheckoutAndInspectUnlocked(activeEpoch),
        submitCheckoutOrder: async (guard) => {
          if (!sessionBarrier.isCurrent(activeEpoch)) {
            return {
              submitted: false,
              haltedBySafetyGate: true,
              code: 'safety_blocked',
              reason: 'Amazon session was reset before Place Order submission.',
            };
          }
          const navWait = waitForNextPageReady(() => true, 18_000);
          const submitRes = await evalStep<{
            submitted: boolean;
            haltedBySafetyGate: boolean;
            code?: string;
            reason?: string;
          }>((reqId) => buildSubmitCheckoutOrderScript(reqId, guard));
          if (submitRes.submitted) {
            await navWait;
            await delay(1500);
          }
          return submitRes;
        },
        readConfirmation: () =>
          evalStep<{
            retailerOrderId: string | null;
            deliveryEstimate?: string | null;
            isConfirmationSurface?: boolean;
            hasAuthOrErrorBarrier?: boolean;
            currentUrl: string;
          }>((reqId) => buildScrapeOrderConfirmationScript(reqId)),
        reconcileViaSyncOrders: () => runSyncOrdersUnlocked(activeEpoch),
        getPreExistingOrderIds: () =>
          purchasesRef.current
            .map((p) => p.retailerOrderId)
            .filter((id): id is string => Boolean(id)),
        onOrderPlacedLocalState: async ({
          item,
          orderRef,
          requestId,
          retailerOrderId,
          placedAt,
          quote,
          shipment,
        }) => {
          if (!sessionBarrier.isCurrent(activeEpoch)) return;
          knownConvexOrderRefByRetailerIdRef.current.set(retailerOrderId, orderRef);
          await syncedCartLedger.remove(item.id);

          const orderId = `order_${placedAt.toString(36)}`;
          const newPurchase: Purchase = {
            orderId,
            orderRef,
            requestId,
            itemId: item.id,
            status: 'placed',
            retailerOrderId,
            placedAt,
            quote,
            simulated: false,
            shipment,
          };

          const nextPurchased = {
            ...purchasedItemsRef.current,
            [item.id]: { ...item, status: 'purchased' as const },
          };
          setPurchasedItems(nextPurchased);
          purchasedItemsRef.current = nextPurchased;

          const targetAsin = extractAsin(item.url);
          const nextActiveItems = itemsRef.current.filter(
            (i) => i.id !== item.id && (targetAsin ? extractAsin(i.url) !== targetAsin : true),
          );
          setItems(nextActiveItems);
          itemsRef.current = nextActiveItems;

          const dedupedPurchases = [
            newPurchase,
            ...purchasesRef.current.filter((p) => p.retailerOrderId !== retailerOrderId),
          ];
          setPurchases(dedupedPurchases);
          purchasesRef.current = dedupedPurchases;
          setLastSyncedAt(placedAt);
          lastSyncedAtRef.current = placedAt;
        },
        submissionLedger: submissionLedgerRef.current,
        syncQueue,
        convexSync: convexSyncRef.current,
        convexCoordinator: autoCheckoutCoordinatorRef.current,
        isSessionCurrent: () => sessionBarrier.isCurrent(activeEpoch),
      });
    },
    [
      closeBrowserSheet,
      enqueueCommand,
      ensureReadySessionEpoch,
      ensureSignedIn,
      evalStep,
      makeUnlockedIsolationDeps,
      proceedToCheckoutAndInspectUnlocked,
      runSyncOrdersUnlocked,
      runVerifiedBrowserLogout,
      sessionBarrier,
      ownerIsReady,
      shopperId,
      submissionClaims,
      syncCartRowsToState,
      syncQueue,
      syncedCartLedger,
      waitForNextPageReady,
    ],
  );

  const refreshCart = useCallback((): Promise<CartItem[]> => {
    const callerEpoch = sessionBarrier.epoch;
    return enqueueCommand(async () => {
      const opEpoch = await ensureReadySessionEpoch(
        sessionBarrier.isLogoutPending ? undefined : callerEpoch,
      );
      await navigateTo(AMAZON_CART_URL);
      if (!sessionBarrier.isCurrent(opEpoch)) {
        return [];
      }
      const snap = await evalStep<{
        signedIn: boolean;
        challenge: AmazonAuthChallenge;
        items: ScrapedAmazonCartRow[];
      }>((reqId) => buildScrapeCartScript(reqId));
      if (!sessionBarrier.isCurrent(opEpoch)) {
        return [];
      }
      setIsSignedIn(snap.signedIn);
      isSignedInRef.current = snap.signedIn;
      setChallenge(snap.challenge);
      challengeRef.current = snap.challenge;
      return syncCartRowsToState(snap.items, Date.now(), opEpoch);
    });
  }, [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, sessionBarrier, syncCartRowsToState]);

  const refreshPurchases = useCallback(async (): Promise<Purchase[]> => {
    const res = await syncOrders();
    return res.purchases;
  }, [syncOrders]);

  // Background WebKit / Chromium 60s idle session keep-alive + AppState foreground wakeup
  useEffect(() => {
    if (Platform.OS === 'web' || !enableBackendDaemon) return;

    const maybeRunHeartbeat = (forceOnForeground = false) => {
      const now = Date.now();
      if (
        shouldRunIdleHeartbeat({
          appState: AppState.currentState,
          busyCount: busyCountRef.current,
          isSheetOpen: isSheetOpenRef.current,
          isResetting: sessionBarrier.isLogoutPending,
          currentUrl: currentUrlRef.current,
          challenge: challengeRef.current,
          lastHeartbeatAt: lastHeartbeatAtRef.current,
          now,
          forceOnForeground,
        })
      ) {
        lastHeartbeatAtRef.current = now;
        void checkSession().catch(() => undefined);
      }
    };

    const interval = setInterval(() => {
      maybeRunHeartbeat(false);
    }, HEARTBEAT_INTERVAL_MS);

    let prevState: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      const returningToForeground =
        (prevState === 'background' || prevState === 'inactive') && nextState === 'active';
      prevState = nextState;

      if (!returningToForeground) return;
      maybeRunHeartbeat(true);

      const last = lastSyncedAtRef.current ?? 0;
      if (Date.now() - last < 15_000) return;

      if (isSignedInRef.current) {
        void syncOrders().catch(() => undefined);
      } else {
        void refreshCart().catch(() => undefined);
      }
    });

    return () => {
      clearInterval(interval);
      sub.remove();
    };
  }, [checkSession, enableBackendDaemon, refreshCart, sessionBarrier, syncOrders]);

  // Android hardware Back button handling while the interactive Amazon browser sheet is open
  useEffect(() => {
    if (Platform.OS !== 'android' || !isSheetOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (canGoBackRef.current && webViewRef.current) {
        webViewRef.current.goBack();
        return true;
      }
      closeBrowserSheet();
      return true;
    });
    return () => sub.remove();
  }, [closeBrowserSheet, isSheetOpen]);

  const listItems = useCallback(async (): Promise<CartItem[]> => {
    if (!ownerIsReady()) return [];
    return [...itemsRef.current]
      .filter((i) => i.status === 'active')
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [ownerIsReady]);

  const getItem = useCallback(async ({ itemId }: { itemId: string }): Promise<CartItem | null> => {
    if (!ownerIsReady()) return null;
    return (
      itemsRef.current.find((i) => i.id === itemId) ??
      purchasedItemsRef.current[itemId] ??
      null
    );
  }, [ownerIsReady]);

  const addItem = useCallback(
    async (args: {
      url: string;
      variant?: string;
      reason?: string;
      quantity?: number;
      idempotencyKey: string;
    }) => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      if (sessionBarrier.isLogoutPending) {
        await enqueueCommand(() => runVerifiedBrowserLogout(sessionBarrier.epoch));
      }
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      const startEpoch = sessionBarrier.epoch;
      return executeIdempotentAddItem({
        idempotencyMap: idempotencyMapRef.current,
        idempotencyKey: args.idempotencyKey,
        isSessionCurrent: () => sessionBarrier.isCurrent(startEpoch),
        runAddToCart: () =>
          addToCart({
            url: args.url,
            quantity: args.quantity,
            variantLabel: args.variant,
            reason: args.reason,
          }),
      });
    },
    [addToCart, enqueueCommand, runVerifiedBrowserLogout, ownerIsReady, sessionBarrier],
  );

  const setQuantity = useCallback(
    async ({ itemId, quantity }: { itemId: string; quantity: number }): Promise<null> => {
      const callerEpoch = sessionBarrier.epoch;
      await enqueueCommand(async () => {
        const opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
        const target = itemsRef.current.find((i) => i.id === itemId);
        const asin = extractAsin(target?.url) ?? extractAsin(itemId);
        if (!asin) {
          throw new Error(`Cannot update Amazon cart quantity: unknown itemId "${itemId}".`);
        }

        await navigateTo(AMAZON_CART_URL);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const liveSnap = await evalStep<{ items: ScrapedAmazonCartRow[] }>((reqId) =>
          buildScrapeCartScript(reqId),
        );
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const plan = computeLiveCartQuantityPlan(liveSnap.items, asin, quantity);
        if (!plan.found) {
          syncCartRowsToState(liveSnap.items, Date.now(), opEpoch);
          throw new Error(`Amazon cart item ${asin} is no longer in the active cart.`);
        }

        if (plan.operation !== 'none' && plan.steps > 0) {
          const stepOp: 'increment' | 'decrement' = plan.operation;
          for (let i = 0; i < plan.steps; i += 1) {
            if (!sessionBarrier.isCurrent(opEpoch)) {
              throw new Error('Amazon session was reset.');
            }
            const mutRes = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
              buildMutateCartRowScript(reqId, asin, stepOp),
            );
            if (!mutRes.mutated) {
              throw new Error(
                `Could not ${stepOp} quantity control for Amazon cart item ${asin} (${mutRes.reason ?? 'unknown'}).`,
              );
            }
            await delay(1100);
          }
        }

        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const finalSnap = await evalStep<{ items: ScrapedAmazonCartRow[] }>((reqId) =>
          buildScrapeCartScript(reqId),
        );
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        syncCartRowsToState(finalSnap.items, Date.now(), opEpoch);
        const verified = verifyFinalCartRowQuantity(finalSnap.items, asin, plan.clampedTarget);
        if (!verified.ok) {
          throw new Error(verified.reason);
        }
      });
      return null;
    },
    [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, sessionBarrier, syncCartRowsToState],
  );

  const removeItem = useCallback(
    async ({ itemId }: { itemId: string }): Promise<null> => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      const asin = extractAsin(target?.url);
      if (!asin) return null;

      const callerEpoch = sessionBarrier.epoch;
      await enqueueCommand(async () => {
        const opEpoch = await ensureReadySessionEpoch(
          sessionBarrier.isLogoutPending ? undefined : callerEpoch,
        );
        await navigateTo(AMAZON_CART_URL);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const mutRes = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
          buildMutateCartRowScript(reqId, asin, 'delete'),
        );
        if (!mutRes.mutated && mutRes.reason !== 'item_not_in_cart') {
          throw new Error(`Could not locate delete control for Amazon cart item ${asin}.`);
        }
        await delay(1400);
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        const snap = await evalStep<{ items: ScrapedAmazonCartRow[] }>((reqId) =>
          buildScrapeCartScript(reqId),
        );
        if (!sessionBarrier.isCurrent(opEpoch)) {
          throw new Error('Amazon session was reset.');
        }
        syncCartRowsToState(snap.items, Date.now(), opEpoch);
        if (snap.items.some((r) => r.asin.toUpperCase() === asin)) {
          throw new Error(`Failed to remove ${asin} from active Amazon cart.`);
        }
      });
      return null;
    },
    [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, sessionBarrier, syncCartRowsToState],
  );

  const applyOwnedCartDelta = useCallback(
    (input: OwnedCartDeltaInput): Promise<OwnedCartDeltaResult> => {
      const asin = extractAsin(input.asin);
      if (!asin) return Promise.reject(new Error('Invalid Amazon ASIN.'));
      const callerEpoch = sessionBarrier.epoch;
      return enqueueCommand(async (): Promise<OwnedCartDeltaResult> => {
        let opEpoch: number;
        try {
          opEpoch = await ensureReadySessionEpoch(sessionBarrier.isLogoutPending ? undefined : callerEpoch);
        } catch (error) {
          return { kind: 'requires_signin', reason: error instanceof Error ? error.message : String(error) };
        }
        const readCart = async () => {
          await navigateTo(AMAZON_CART_URL);
          if (!sessionBarrier.isCurrent(opEpoch)) throw new Error('Amazon session was reset.');
          const snap = await evalStep<{ signedIn: boolean; challenge: AmazonAuthChallenge; items: ScrapedAmazonCartRow[] }>(
            (reqId) => buildScrapeCartScript(reqId),
          );
          if (!sessionBarrier.isCurrent(opEpoch)) throw new Error('Amazon session was reset.');
          const rows = snap.items.filter((row) => row.asin.trim().toUpperCase() === asin);
          return { snap, rowCount: rows.length, qty: rows.reduce((sum, row) => sum + row.quantity, 0) };
        };

        const before = await readCart();
        if (!before.snap.signedIn || before.snap.challenge !== 'none') {
          return { kind: 'requires_signin', reason: 'Amazon sign-in is required.' };
        }
        syncCartRowsToState(before.snap.items, Date.now(), opEpoch);
        if (input.expectedLiveQty !== null && before.qty !== input.expectedLiveQty) {
          return { kind: 'drift', liveQty: before.qty, rowCount: before.rowCount };
        }
        if (input.delta === 0 || input.delta > 10) {
          return { kind: 'observed', liveQty: before.qty, rowCount: before.rowCount };
        }
        const target = before.qty + input.delta;
        if (input.delta < 0 && (before.rowCount !== 1 || target < 0)) {
          return { kind: 'drift', liveQty: before.qty, rowCount: before.rowCount };
        }

        let error: string | undefined;
        try {
          if (input.delta > 0) {
            const added = await runAddToCartUnlocked(
              {
                asin,
                url: canonicalAmazonProductUrl(asin),
                quantity: input.delta,
                variantLabel: input.variantLabel ?? undefined,
              },
              opEpoch,
            );
            if (!added.ok) error = added.error;
          } else if (target === 0) {
            const res = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
              buildMutateCartRowScript(reqId, asin, 'delete'),
            );
            if (!res.mutated) error = res.reason ?? 'delete_control_not_found';
            await delay(1400);
          } else {
            for (let step = 0; step < -input.delta; step += 1) {
              if (!sessionBarrier.isCurrent(opEpoch)) throw new Error('Amazon session was reset.');
              const res = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
                buildMutateCartRowScript(reqId, asin, 'decrement'),
              );
              if (!res.mutated) {
                error = res.reason ?? 'decrement_control_not_found';
                break;
              }
              await delay(1100);
            }
          }
        } catch (mutationError) {
          error = mutationError instanceof Error ? mutationError.message : String(mutationError);
        }

        if (!sessionBarrier.isCurrent(opEpoch)) {
          return { kind: 'mutated', beforeQty: before.qty, afterQty: null, error: 'Amazon session was reset.' };
        }
        try {
          const after = await readCart();
          syncCartRowsToState(after.snap.items, Date.now(), opEpoch);
          return { kind: 'mutated', beforeQty: before.qty, afterQty: after.qty, error };
        } catch (readError) {
          return {
            kind: 'mutated',
            beforeQty: before.qty,
            afterQty: null,
            error: readError instanceof Error ? readError.message : String(readError),
          };
        }
      });
    },
    [enqueueCommand, ensureReadySessionEpoch, evalStep, navigateTo, runAddToCartUnlocked, sessionBarrier, syncCartRowsToState],
  );

  useEffect(() => {
    ownedCartSync.setEngine({
      applyDelta: applyOwnedCartDelta,
      canRun: () =>
        Platform.OS !== 'web' &&
        ownerIsReady() &&
        isSignedInRef.current &&
        !sessionBarrier.isLogoutPending &&
        AppState.currentState === 'active',
    });
    return () => ownedCartSync.setEngine(null);
  }, [applyOwnedCartDelta, ownedCartSync, ownerIsReady, sessionBarrier]);

  const ownedCartShopperRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const next = shopperId ?? null;
    const previous = ownedCartShopperRef.current;
    ownedCartShopperRef.current = next;
    if (previous === undefined) {
      void ownedCartSync.hydrate(next);
    } else if (previous !== next) {
      void ownedCartSync.reset(next);
    }
  }, [ownedCartSync, shopperId]);

  useEffect(() => {
    if (Platform.OS !== 'web' && ownerReady && isSignedIn) ownedCartSync.resume();
  }, [isSignedIn, ownedCartSync, ownerReady]);

  const ownedCartItems = useSyncExternalStore(ownedCartSync.subscribe, ownedCartSync.getItems, ownedCartSync.getItems);
  const cartSyncValue = useMemo<AmazonCartSyncValue>(
    () => ({
      items: ownerReady ? ownedCartItems : {},
      setIntent: (input) => ownedCartSync.setIntent(input),
      retry: (itemId) => ownedCartSync.retry(itemId),
      dismiss: (itemId) => ownedCartSync.dismiss(itemId),
      resume: () => ownedCartSync.resume(),
    }),
    [ownedCartItems, ownedCartSync, ownerReady],
  );

  const listPurchases = useCallback(async (): Promise<Purchase[]> => {
    if (!ownerIsReady()) return [];
    return [...purchasesRef.current].sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0));
  }, [ownerIsReady]);

  const requestPurchase = useCallback(
    async (args: {
      itemId: string;
      offerId: string;
      quantity: number;
      reason: string;
      idempotencyKey: string;
    }) => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      if (sessionBarrier.isLogoutPending) {
        await enqueueCommand(() => runVerifiedBrowserLogout(sessionBarrier.epoch));
      }
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      const startEpoch = sessionBarrier.epoch;
      const knownReqId = idempotencyMapRef.current.get(args.idempotencyKey);
      const existingReq = knownReqId
        ? pendingRequestsRef.current.find((r) => r.requestId === knownReqId)
        : undefined;
      if (existingReq) {
        return {
          requestId: existingReq.requestId,
          status: existingReq.status,
          quoteVersion: existingReq.quoteVersion,
          expiresAt: existingReq.expiresAt,
          quote: existingReq.quote,
        };
      }

      const target = itemsRef.current.find((i) => i.id === args.itemId);
      const asin = extractAsin(target?.url);
      const quoteRes = await getCheckoutQuote({
        asin: asin ?? undefined,
        quantity: args.quantity,
        dryRun: true,
      });
      if (!sessionBarrier.isCurrent(startEpoch)) {
        throw new Error('Amazon session was reset before purchase request completed.');
      }

      const now = Date.now();
      const requestId = `req_${now.toString(36)}`;
      const expiresAt = now + QUOTE_TTL_MS;

      const reqRecord: PurchaseRequest = {
        requestId,
        itemId: args.itemId,
        offerId: args.offerId,
        status: quoteRes.quote ? 'pending_approval' : 'failed',
        requestedBy: 'app',
        reason: args.reason,
        quantity: args.quantity,
        quoteVersion: 1,
        quote: quoteRes.quote,
        expiresAt,
        decidedAt: null,
        requestedAt: now,
        error: quoteRes.error ?? null,
        order: null,
        shipment: null,
      };

      idempotencyMapRef.current.set(args.idempotencyKey, requestId);
      const nextRequests = [reqRecord, ...pendingRequestsRef.current];
      setPendingRequests(nextRequests);
      pendingRequestsRef.current = nextRequests;

      if (quoteRes.quote && !quoteRes.requiresSignIn) {
        void syncQueue.enqueueQuote(
          buildAttachClientQuoteArgs({
            requestId,
            quoteVersion: 1,
            quote: quoteRes.quote,
          }),
          convexSyncRef.current,
        );
      }

      return {
        requestId,
        status: reqRecord.status,
        quoteVersion: 1,
        expiresAt,
        quote: quoteRes.quote,
      };
    },
    [enqueueCommand, getCheckoutQuote, runVerifiedBrowserLogout, ownerIsReady, sessionBarrier, syncQueue],
  );

  const decidePurchase = useCallback(
    async (args: {
      requestId: string;
      quoteVersion: number;
      decision: 'approve' | 'defer';
      dryRun?: boolean;
      userConfirmed?: boolean;
    }): Promise<{
      outcome: DecidePurchaseOutcome;
      request: PurchaseRequest;
      orderResult?: AmazonPlaceOrderResult;
    }> => {
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      if (sessionBarrier.isLogoutPending) {
        await enqueueCommand(() => runVerifiedBrowserLogout(sessionBarrier.epoch));
      }
      if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
      const startEpoch = sessionBarrier.epoch;
      const existing = pendingRequestsRef.current.find((r) => r.requestId === args.requestId);
      if (!existing) {
        throw new Error(`PurchaseRequest ${args.requestId} not found`);
      }
      if (existing.order?.status === 'placed') {
        void syncQueue.flush(convexSyncRef.current);
        return { outcome: 'already_approved', request: existing };
      }
      if (existing.order?.status === 'unknown') {
        const ledgerCheck = submissionLedgerRef.current.get(existing.order.orderRef);
        if (ledgerCheck?.state === 'placed') {
          const applied = applyLedgerReconciliationsToState({
            reconciled: [
              {
                orderRef: existing.order.orderRef,
                retailerOrderId: ledgerCheck.retailerOrderId,
                placedAt: ledgerCheck.placedAt,
              },
            ],
            pendingRequests: pendingRequestsRef.current,
            items: itemsRef.current,
            purchasedItems: purchasedItemsRef.current,
            syncedPurchases: purchasesRef.current,
          });
          setPendingRequests(applied.pendingRequests);
          pendingRequestsRef.current = applied.pendingRequests;
          setItems(applied.items);
          itemsRef.current = applied.items;
          setPurchasedItems(applied.purchasedItems);
          purchasedItemsRef.current = applied.purchasedItems;
          setPurchases(applied.purchases);
          purchasesRef.current = applied.purchases;
          const promoted =
            applied.pendingRequests.find((r) => r.requestId === args.requestId) ?? existing;
          return { outcome: 'already_approved', request: promoted };
        }
        return { outcome: 'unknown', request: existing };
      }
      if (Date.now() > existing.expiresAt) {
        return { outcome: 'expired', request: { ...existing, status: 'expired' } };
      }
      if (existing.quoteVersion !== args.quoteVersion) {
        return { outcome: 'stale_quote', request: existing };
      }

      if (args.decision === 'defer') {
        const updated: PurchaseRequest = {
          ...existing,
          status: 'deferred',
          decidedAt: Date.now(),
        };
        setPendingRequests((prev) =>
          prev.map((r) => (r.requestId === args.requestId ? updated : r)),
        );
        return { outcome: 'deferred', request: updated };
      }

      const targetItem = itemsRef.current.find((i) => i.id === existing.itemId);
      const asin = extractAsin(targetItem?.url);
      if (!targetItem || targetItem.status !== 'active' || !asin) {
        return { outcome: 'invalid_state', request: existing };
      }
      const orderRef = `CART-${existing.requestId.toUpperCase()}`;

      const orderResult = await placeOrder({
        asin,
        quantity: existing.quantity,
        orderRef,
        expectedTotalCents: existing.quote?.totalCents,
        dryRun: args.dryRun ?? true,
        userConfirmed: args.userConfirmed ?? false,
      });

      if (!sessionBarrier.isCurrent(startEpoch)) {
        return { outcome: 'invalid_state', request: existing, orderResult };
      }

      if (orderResult.status === 'dry_run_halted') {
        return { outcome: 'dry_run_halted', request: existing, orderResult };
      }

      if (orderResult.status === 'requires_signin') {
        return { outcome: 'requires_signin', request: existing, orderResult };
      }

      if (orderResult.status === 'basket_mismatch') {
        return { outcome: 'basket_mismatch', request: existing, orderResult };
      }

      if (orderResult.status === 'safety_blocked') {
        return { outcome: 'safety_blocked', request: existing, orderResult };
      }

      if (orderResult.status === 'requote_required') {
        const bumped: PurchaseRequest = {
          ...existing,
          quoteVersion: existing.quoteVersion + 1,
          quote: orderResult.quote ?? existing.quote,
        };
        setPendingRequests((prev) =>
          prev.map((r) => (r.requestId === args.requestId ? bumped : r)),
        );
        return { outcome: 'stale_quote', request: bumped, orderResult };
      }

      if (orderResult.status === 'unknown') {
        const now = Date.now();
        const unknownReq: PurchaseRequest = {
          ...existing,
          status: 'approved',
          decidedAt: now,
          order: {
            orderId: `order_${now.toString(36)}`,
            orderRef,
            status: 'unknown',
            retailerOrderId: null,
            placedAt: null,
            simulated: false,
          },
          shipment: null,
        };
        const nextPending = pendingRequestsRef.current.map((r) =>
          r.requestId === args.requestId ? unknownReq : r,
        );
        setPendingRequests(nextPending);
        pendingRequestsRef.current = nextPending;
        return { outcome: 'unknown', request: unknownReq, orderResult };
      }

      if (orderResult.status === 'placed' && existing.quote) {
        const placedAt = orderResult.placedAt ?? Date.now();
        const orderId = `order_${placedAt.toString(36)}`;
        const eta = parseDeliveryEtaIso(existing.quote.deliveryEstimate, placedAt);
        const placedShipment: Shipment =
          orderResult.shipment ?? {
            status: 'ordered',
            carrier: null,
            trackingNumber: null,
            trackingUrl: null,
            eta,
            events: buildShipmentEvents({
              status: 'ordered',
              headline: 'Order placed on Amazon',
              placedAt,
              updatedAt: placedAt,
            }),
            updatedAt: placedAt,
            simulated: false,
          };

        const newPurchase: Purchase = {
          orderId,
          orderRef,
          requestId: existing.requestId,
          itemId: existing.itemId,
          status: 'placed',
          retailerOrderId: orderResult.retailerOrderId,
          placedAt,
          quote: orderResult.quote ?? existing.quote,
          simulated: false,
          shipment: placedShipment,
        };

        if (targetItem) {
          const nextPurchased = {
            ...purchasedItemsRef.current,
            [targetItem.id]: { ...targetItem, status: 'purchased' as const },
          };
          setPurchasedItems(nextPurchased);
          purchasedItemsRef.current = nextPurchased;

          const nextActiveItems = itemsRef.current.filter((i) => i.id !== targetItem.id);
          setItems(nextActiveItems);
          itemsRef.current = nextActiveItems;
        }

        const nextPurchases = [newPurchase, ...purchasesRef.current];
        setPurchases(nextPurchases);
        purchasesRef.current = nextPurchases;

        const completedReq: PurchaseRequest = {
          ...existing,
          status: 'ordered',
          decidedAt: placedAt,
          order: {
            orderId,
            orderRef,
            status: 'placed',
            retailerOrderId: orderResult.retailerOrderId,
            placedAt,
            simulated: false,
          },
          shipment: newPurchase.shipment,
        };
        const nextPending = pendingRequestsRef.current.map((r) =>
          r.requestId === args.requestId ? completedReq : r,
        );
        setPendingRequests(nextPending);
        pendingRequestsRef.current = nextPending;
        return { outcome: 'approved', request: completedReq, orderResult };
      }

      return { outcome: 'invalid_state', request: existing, orderResult };
    },
    [enqueueCommand, placeOrder, runVerifiedBrowserLogout, ownerIsReady, sessionBarrier, syncQueue],
  );

  const status: AmazonSessionStatus =
    busyCount > 0 ? 'busy' : isSignedIn ? 'connected' : 'signed_out';
  const browserEngine = selectBrowserEngine(Platform.OS);

  const normalizedShopperId =
    typeof shopperId === 'string' && shopperId.trim().length > 0 ? shopperId.trim() : null;

  const noteKnownConvexPurchases = useCallback((convexPurchases: Purchase[]) => {
    if (!ownerIsReady()) return;
    for (const p of convexPurchases) {
      if (p.retailerOrderId && p.orderRef) {
        knownConvexOrderRefByRetailerIdRef.current.set(p.retailerOrderId, p.orderRef);
      }
    }
  }, [ownerIsReady]);

  const enqueueQuoteSync = useCallback(
    (args: AttachClientQuoteArgs) => {
      if (!ownerIsReady() || sessionBarrier.isLogoutPending) {
        return Promise.resolve({
          synced: 0,
          remaining: syncQueue.pendingCount,
          lastSyncError: 'Amazon sign-out verification is pending.',
        });
      }
      return syncQueue.enqueueQuote(args, convexSyncRef.current);
    },
    [ownerIsReady, sessionBarrier, syncQueue],
  );

  const enqueueShipmentSync = useCallback(
    (args: SyncClientShipmentArgs) => {
      if (!ownerIsReady() || sessionBarrier.isLogoutPending) {
        return Promise.resolve({
          synced: 0,
          remaining: syncQueue.pendingCount,
          lastSyncError: 'Amazon sign-out verification is pending.',
        });
      }
      return syncQueue.enqueueShipment(args, convexSyncRef.current);
    },
    [ownerIsReady, sessionBarrier, syncQueue],
  );

  const daemonBridgeValue = useMemo<AmazonDaemonBridgeValue>(
    () => ({
      hasCustomConvexSync: Boolean(convexSync),
      registerAutoConvexBridge,
      getSyncedCartLedger: () => {
        if (!ownerIsReady()) throw new Error('Amazon browser ownership is not verified.');
        return syncedCartLedger;
      },
      getShopperId: () => ownerIsReady() ? normalizedShopperId : null,
      isSignedIn: () => ownerIsReady() && isSignedInRef.current,
      isSheetOpen: () => isSheetOpenRef.current,
      isResetting: () => !ownerIsReady() || sessionBarrier.isLogoutPending,
      isCheckoutInFlight: () => checkoutInFlightCountRef.current > 0,
      isSignedInReactive: ownerReady && isSignedIn,
      shopperIdReactive: normalizedShopperId,
      localPurchasesReactive: ownerReady ? purchases : [],
      noteKnownConvexPurchases,
      addToCart,
      setQuantity,
      refreshCart,
      quoteSingleItem,
      syncOrders,
      enqueueQuoteSync,
      enqueueShipmentSync,
    }),
    [
      ownerReady,
      addToCart,
      convexSync,
      enqueueQuoteSync,
      enqueueShipmentSync,
      isSignedIn,
      normalizedShopperId,
      ownerIsReady,
      noteKnownConvexPurchases,
      purchases,
      quoteSingleItem,
      refreshCart,
      registerAutoConvexBridge,
      sessionBarrier,
      setQuantity,
      syncOrders,
      syncedCartLedger,
    ],
  );

  const sessionValue = useMemo<AmazonSessionHookValue>(
    () => ({
      status: ownerReady ? status : 'signed_out',
      browserEngine,
      shopperId: normalizedShopperId,
      isSheetOpen: ownerReady && isSheetOpen,
      currentUrl: ownerReady ? currentUrl : AMAZON_SIGNIN_URL,
      challenge: ownerReady ? challenge : 'signin',
      lastSyncedAt: ownerReady ? lastSyncedAt : null,
      lastSyncError,
      pendingSyncCount,
      openBrowserSheet,
      closeBrowserSheet,
      ensureSignedIn,
      resetSession,
      signOut: resetSession,
      checkSession,
      addToCart,
      getCheckoutQuote,
      placeOrder,
      checkoutAmazonItem,
      syncOrders,
      flushPendingSync,
    }),
    [
      ownerReady,
      status,
      browserEngine,
      normalizedShopperId,
      isSheetOpen,
      currentUrl,
      challenge,
      lastSyncedAt,
      lastSyncError,
      pendingSyncCount,
      openBrowserSheet,
      closeBrowserSheet,
      ensureSignedIn,
      resetSession,
      checkSession,
      addToCart,
      getCheckoutQuote,
      placeOrder,
      checkoutAmazonItem,
      syncOrders,
      flushPendingSync,
    ],
  );

  const adapterValue = useMemo<AmazonCartAdapterValue>(
    () => ({
      items: ownerReady ? items : [],
      purchases: ownerReady ? purchases : [],
      purchasedItems: ownerReady ? purchasedItems : {},
      pendingRequests: ownerReady ? pendingRequests : [],
      lastSyncedAt,
      lastSyncError,
      pendingSyncCount,
      listItems,
      getItem,
      addItem,
      setQuantity,
      removeItem,
      listPurchases,
      requestPurchase,
      decidePurchase,
      checkoutAmazonItem,
      refreshCart,
      refreshPurchases,
      resetSession,
      flushPendingSync,
    }),
    [
      ownerReady,
      items,
      purchases,
      purchasedItems,
      pendingRequests,
      lastSyncedAt,
      lastSyncError,
      pendingSyncCount,
      listItems,
      getItem,
      addItem,
      setQuantity,
      removeItem,
      listPurchases,
      requestPurchase,
      decidePurchase,
      checkoutAmazonItem,
      refreshCart,
      refreshPurchases,
      resetSession,
      flushPendingSync,
    ],
  );

  const contextValue = useMemo<CombinedAmazonContextValue>(
    () => ({ session: sessionValue, adapter: adapterValue, cartSync: cartSyncValue }),
    [sessionValue, adapterValue, cartSyncValue],
  );

  const offscreenOffset = Math.max(dimensions.height * 2, 2400);

  return (
    <AmazonDaemonBridgeContext.Provider value={daemonBridgeValue}>
      <AmazonContext.Provider value={contextValue}>
        <AmazonSyncDaemon enabled={enableBackendDaemon && ownerReady} />
        <View style={styles.root}>
          {children}

          {Platform.OS !== 'web' && (
            <View
              collapsable={false}
              pointerEvents={ownerReady && isSheetOpen ? 'auto' : 'none'}
              accessibilityElementsHidden={!ownerReady || !isSheetOpen}
              importantForAccessibility={ownerReady && isSheetOpen ? 'yes' : 'no-hide-descendants'}
              style={[
                styles.sheetOverlay,
                {
                  width: dimensions.width,
                  height: dimensions.height,
                  paddingTop: insets.top,
                  transform: [{ translateY: ownerReady && isSheetOpen ? 0 : offscreenOffset }],
                },
              ]}>
              <View style={styles.sheetHeader}>
                <Text style={styles.sheetSubtitle} numberOfLines={1}>
                  Sign in to Amazon so Cart can check out and track orders for you
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Close Amazon browser"
                  hitSlop={12}
                  onPress={closeBrowserSheet}
                  style={({ pressed }) => [
                    styles.closeButton,
                    pressed && styles.closeButtonPressed,
                  ]}>
                  <Text style={styles.closeButtonLabel}>Close</Text>
                </Pressable>
              </View>

              {isPageLoading && <View style={styles.loadingBar} />}

              <View collapsable={false} style={styles.webViewFrame}>
                <WebView<Record<string, unknown>>
                  ref={webViewRef}
                  source={{ uri: AMAZON_CART_URL }}
                  userAgent={selectBrowserUserAgent(Platform.OS)}
                  sharedCookiesEnabled
                  thirdPartyCookiesEnabled
                  domStorageEnabled
                  javaScriptEnabled
                  javaScriptCanOpenWindowsAutomatically
                  setSupportMultipleWindows={false}
                  mixedContentMode="compatibility"
                  cacheEnabled
                  overScrollMode="never"
                  useSharedProcessPool
                  allowsBackForwardNavigationGestures
                  contentMode="mobile"
                  injectedJavaScript={AMAZON_PAGE_BOOTSTRAP_JS}
                  onMessage={handleWebViewMessage}
                  onNavigationStateChange={handleNavigationStateChange}
                  onLoadEnd={handleLoadEnd}
                  style={styles.webView}
                />
              </View>
            </View>
          )}
        </View>
      </AmazonContext.Provider>
    </AmazonDaemonBridgeContext.Provider>
  );
}

export function useAmazonSession(): AmazonSessionHookValue {
  const ctx = useContext(AmazonContext);
  if (!ctx) {
    throw new Error('useAmazonSession must be used inside <AmazonBrowserProvider>.');
  }
  return ctx.session;
}

export function useAmazonCartSync(): AmazonCartSyncValue {
  const ctx = useContext(AmazonContext);
  if (!ctx) {
    throw new Error('useAmazonCartSync must be used inside <AmazonBrowserProvider>.');
  }
  return ctx.cartSync;
}

export function useAmazonCartAdapter(): AmazonCartAdapterValue {
  const ctx = useContext(AmazonContext);
  if (!ctx) {
    throw new Error('useAmazonCartAdapter must be used inside <AmazonBrowserProvider>.');
  }
  return ctx.adapter;
}

function createProviderStyles(colors: Palette) {
  return StyleSheet.create({
    root: {
      flex: 1,
    },
    sheetOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      zIndex: 9999,
      backgroundColor: colors.background,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: Spacing.md,
      paddingHorizontal: Spacing.lg,
      paddingVertical: Spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.hairline,
      backgroundColor: colors.background,
    },
    sheetSubtitle: {
      ...Type.secondary,
      flex: 1,
      color: colors.textSecondary,
    },
    closeButton: {
      paddingVertical: 6,
      paddingHorizontal: Spacing.xs,
    },
    closeButtonPressed: {
      opacity: 0.6,
    },
    closeButtonLabel: {
      ...Type.body,
      fontWeight: '600',
      color: colors.text,
    },
    loadingBar: {
      height: 2,
      backgroundColor: colors.accent,
    },
    webViewFrame: {
      flex: 1,
      backgroundColor: colors.surface,
    },
    webView: {
      flex: 1,
    },
  });
}
