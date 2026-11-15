import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from 'react-native-webview';

import { Colors, Spacing, Type } from '@/constants/theme';

import {
  AMAZON_CART_URL,
  AMAZON_ORDERS_URL,
  AMAZON_SIGNIN_URL,
  amazonOfferListingUrl,
  buildShipmentEvents,
  canonicalAmazonProductUrl,
  extractAsin,
  isAmazonShortLink,
  normalizeShipmentStatus,
  parseDeliveryEtaIso,
} from './asin';
import {
  buildAttachClientQuoteArgs,
  buildRecordClientPlacementArgs,
  buildSyncClientShipmentArgs,
  type ConvexAmazonSyncClient,
} from './convex-sync';
import {
  evaluatePreSubmitSafetyGate,
  isValidPositiveCents,
  normalizeApprovedItems,
  OrderSubmissionLedger,
  resolveOrderConfirmationOutcome,
  verifyActiveBasketBinding,
  verifyCheckoutReviewBinding,
} from './safety';
import {
  AMAZON_PAGE_BOOTSTRAP_JS,
  buildAodAddToCartScript,
  buildClickProceedToCheckoutScript,
  buildInspectCheckoutReviewScript,
  buildMutateCartRowScript,
  buildProductScrapeAndAddScript,
  buildResolvePageAsinScript,
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

const IPHONE_SAFARI_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

const ESTIMATED_TAX_RATE = 0.0825;
const QUOTE_TTL_MS = 30 * 60 * 1000;

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
   * Optional 5-line bridge to Convex client-sync mutations (`MOBI-9`):
   * `attachClientQuote`, `recordClientPlacement`, and `syncClientShipment`.
   */
  convexSync?: ConvexAmazonSyncClient;
}

export function AmazonBrowserProvider({ children, convexSync }: AmazonBrowserProviderProps) {
  const insets = useSafeAreaInsets();
  const dimensions = useWindowDimensions();
  const webViewRef = useRef<NativeWebViewInstance | null>(null);
  const convexSyncRef = useRef<ConvexAmazonSyncClient | undefined>(convexSync);

  useEffect(() => {
    convexSyncRef.current = convexSync;
  }, [convexSync]);

  const [isSignedIn, setIsSignedIn] = useState(false);
  const [busyCount, setBusyCount] = useState(0);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isPageLoading, setIsPageLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState<string>(AMAZON_CART_URL);
  const [challenge, setChallenge] = useState<AmazonAuthChallenge>('none');
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);

  const [items, setItems] = useState<CartItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchasedItems, setPurchasedItems] = useState<Record<string, CartItem>>({});
  const [pendingRequests, setPendingRequests] = useState<PurchaseRequest[]>([]);

  const itemsRef = useRef<CartItem[]>(items);
  const purchasesRef = useRef<Purchase[]>(purchases);
  const purchasedItemsRef = useRef<Record<string, CartItem>>(purchasedItems);
  const pendingRequestsRef = useRef<PurchaseRequest[]>(pendingRequests);
  const isSignedInRef = useRef(isSignedIn);
  const lastSyncedAtRef = useRef<number | null>(lastSyncedAt);
  const currentUrlRef = useRef(currentUrl);

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

  const notifyPageReady = useCallback(
    (url: string, signedIn: boolean, nextChallenge: AmazonAuthChallenge) => {
      if (url) {
        setCurrentUrl(url);
        currentUrlRef.current = url;
      }
      setChallenge(nextChallenge);
      setIsSignedIn(signedIn);
      if (signedIn) {
        settleSignInWaiters(true);
      }

      if (pageWaitersRef.current.size > 0) {
        for (const waiter of Array.from(pageWaitersRef.current)) {
          if (waiter.predicate(url)) {
            clearTimeout(waiter.timer);
            pageWaitersRef.current.delete(waiter);
            waiter.resolve({ url, signedIn, challenge: nextChallenge });
          }
        }
      }
    },
    [settleSignInWaiters],
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

  const enqueueCommand = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    setBusyCount((c) => c + 1);
    const next = commandQueueRef.current.then(task, task);
    commandQueueRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next.finally(() => {
      setBusyCount((c) => Math.max(0, c - 1));
    });
  }, []);

  const syncCartRowsToState = useCallback((rows: ScrapedAmazonCartRow[], syncedAt: number): CartItem[] => {
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
  }, []);

  const openBrowserSheet = useCallback((initialUrl?: string) => {
    setIsSheetOpen(true);
    if (initialUrl && webViewRef.current) {
      webViewRef.current.injectJavaScript(
        `window.location.assign(${JSON.stringify(initialUrl)}); true;`,
      );
    } else if (
      !isSignedInRef.current &&
      !currentUrlRef.current.includes('/ap/signin') &&
      webViewRef.current
    ) {
      webViewRef.current.injectJavaScript(
        `window.location.assign(${JSON.stringify(AMAZON_SIGNIN_URL)}); true;`,
      );
    }
  }, []);

  const closeBrowserSheet = useCallback(() => {
    setIsSheetOpen(false);
    if (!isSignedInRef.current) {
      settleSignInWaiters(false);
    }
  }, [settleSignInWaiters]);

  const checkSession = useCallback((): Promise<AmazonSessionCheckResult> => {
    return enqueueCommand(async () => {
      if (!currentUrlRef.current.includes('amazon.com')) {
        await navigateTo(AMAZON_CART_URL);
      }
      const res = await evalStep<AmazonSessionCheckResult>((reqId) => buildSessionCheckScript(reqId));
      setIsSignedIn(res.signedIn);
      setChallenge(res.challenge);
      setLastSyncedAt(res.checkedAt);
      return res;
    });
  }, [enqueueCommand, evalStep, navigateTo]);

  const ensureSignedIn = useCallback(async (): Promise<boolean> => {
    const check = await checkSession();
    if (check.signedIn) return true;

    return new Promise<boolean>((resolve) => {
      signInWaitersRef.current.add(resolve);
      openBrowserSheet(AMAZON_SIGNIN_URL);
    });
  }, [checkSession, openBrowserSheet]);

  const addToCart = useCallback(
    (input: AmazonAddToCartInput): Promise<AmazonAddToCartResult> => {
      return enqueueCommand(async () => {
        const requestedQty = Math.max(1, Math.min(10, Math.floor(input.quantity ?? 1)));
        let asin = extractAsin(input.asin ?? input.url);

        if (!asin && input.url && isAmazonShortLink(input.url)) {
          await navigateTo(input.url);
          const resolved = await evalStep<{ asin: string | null; url: string }>((reqId) =>
            buildResolvePageAsinScript(reqId),
          );
          asin = resolved.asin;
        }

        if (!asin) {
          throw new Error('Could not extract a 10-character Amazon ASIN from the provided URL.');
        }

        await navigateTo(canonicalAmazonProductUrl(asin));
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

        if (productAttempt.status === 'captcha') {
          setChallenge('captcha');
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
        if (productAttempt.status === 'needs_aod_fallback') {
          usedAodFallback = true;
          await navigateTo(amazonOfferListingUrl(asin));
          const aodRes = await evalStep<{
            clicked: boolean;
            seller: string | null;
            priceCents: number | null;
          }>((reqId) => buildAodAddToCartScript(reqId), 14_000);

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
        await navigateTo(AMAZON_CART_URL);

        const scrapedCart = await evalStep<{
          signedIn: boolean;
          challenge: AmazonAuthChallenge;
          currentUrl: string;
          cartCount: number;
          subtotalCents: number;
          items: ScrapedAmazonCartRow[];
        }>((reqId) => buildScrapeCartScript(reqId));

        setIsSignedIn(scrapedCart.signedIn);
        setChallenge(scrapedCart.challenge);

        const syncedAt = Date.now();
        const nextItems = syncCartRowsToState(scrapedCart.items, syncedAt);
        const addedItem =
          nextItems.find((i) => extractAsin(i.url) === asin) ?? nextItems[0] ?? null;

        return {
          ok: addedItem !== null,
          asin,
          usedAodFallback,
          cartCount: scrapedCart.cartCount,
          subtotalCents: scrapedCart.subtotalCents,
          addedItem,
          cartRows: scrapedCart.items,
          syncedAt,
        };
      });
    },
    [enqueueCommand, evalStep, navigateTo, syncCartRowsToState],
  );

  const getCheckoutQuote = useCallback(
    (input: AmazonCheckoutQuoteInput = {}): Promise<AmazonCheckoutQuoteResult> => {
      const effectiveDryRun = input.dryRun ?? true;

      return enqueueCommand(async () => {
        await navigateTo(AMAZON_CART_URL);
        const cartSnap = await evalStep<{
          signedIn: boolean;
          challenge: AmazonAuthChallenge;
          currentUrl: string;
          cartCount: number;
          subtotalCents: number;
          items: ScrapedAmazonCartRow[];
        }>((reqId) => buildScrapeCartScript(reqId));

        const now = Date.now();
        const syncedItems = syncCartRowsToState(cartSnap.items, now);

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

        const quotedAt = Date.now();
        setLastSyncedAt(quotedAt);

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
          setChallenge(review.stage === 'captcha_gate' ? 'captcha' : 'signin');

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
        setChallenge('none');

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
    [enqueueCommand, evalStep, navigateTo, syncCartRowsToState, waitForNextPageReady],
  );

  const placeOrder = useCallback(
    async (input: AmazonPlaceOrderInput): Promise<AmazonPlaceOrderResult> => {
      const dryRun = input.dryRun ?? true;
      const userConfirmed = input.userConfirmed ?? false;
      const orderRef = input.orderRef ?? `CART-${Date.now().toString(36).toUpperCase()}`;

      // 1. Reconcile-before-retry ledger check: never double-submit `'placed'` OR `'unknown'` orderRef
      const ledgerEntry = submissionLedgerRef.current.get(orderRef);
      if (ledgerEntry?.state === 'placed') {
        return {
          status: 'placed',
          safetyGate: { dryRun, userConfirmed, orderSubmitted: false },
          orderRef,
          retailerOrderId: ledgerEntry.retailerOrderId,
          placedAt: ledgerEntry.placedAt,
          quote: null,
          shipment: null,
          reason: 'Idempotent replay: returning existing placed order.',
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
        );

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
            orderRef,
            retailerOrderId: null,
            placedAt: null,
            quote: verifiedQuote,
            shipment: null,
            reason: submitRes.reason,
          };
        }

        // Record in ledger immediately after click so no retry can double-click if confirmation fails
        const submitTimestamp = Date.now();
        submissionLedgerRef.current.recordUnknown(
          orderRef,
          submitTimestamp,
          gateDecision.approvedItems.map((i) => i.asin),
        );

        await navWait;
        await delay(1500);
        const confirmation = await evalStep<{
          retailerOrderId: string | null;
          isConfirmationSurface?: boolean;
          hasAuthOrErrorBarrier?: boolean;
          currentUrl: string;
        }>((reqId) => buildScrapeOrderConfirmationScript(reqId));

        const resolution = resolveOrderConfirmationOutcome(confirmation);
        setLastSyncedAt(Date.now());

        if (resolution.status === 'unknown') {
          return {
            status: 'unknown',
            safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
            orderRef,
            retailerOrderId: null,
            placedAt: null,
            quote: verifiedQuote,
            shipment: null,
            reason: resolution.reason,
          };
        }

        const placedAt = Date.now();
        const retailerOrderId = resolution.retailerOrderId;
        const initialShipment: Shipment = {
          status: 'ordered',
          carrier: null,
          trackingNumber: null,
          trackingUrl: null,
          eta: parseDeliveryEtaIso(verifiedQuote.deliveryEstimate, placedAt),
          events: buildShipmentEvents({
            status: 'ordered',
            headline: 'Order placed on Amazon',
            placedAt,
            updatedAt: placedAt,
          }),
          updatedAt: placedAt,
          simulated: false,
        };

        submissionLedgerRef.current.recordPlaced(orderRef, retailerOrderId, placedAt);

        if (convexSyncRef.current?.recordClientPlacement) {
          void convexSyncRef.current
            .recordClientPlacement(
              buildRecordClientPlacementArgs({
                orderRef,
                retailerOrderId,
                placedAt,
                shipment: initialShipment,
              }),
            )
            .catch(() => undefined);
        }

        return {
          status: 'placed',
          safetyGate: { dryRun: false, userConfirmed: true, orderSubmitted: true },
          orderRef,
          retailerOrderId,
          placedAt,
          quote: verifiedQuote,
          shipment: initialShipment,
        };
      });
    },
    [enqueueCommand, evalStep, getCheckoutQuote, waitForNextPageReady],
  );

  const syncOrders = useCallback((): Promise<AmazonSyncOrdersResult> => {
    return enqueueCommand(async () => {
      await navigateTo(AMAZON_ORDERS_URL);
      const scraped = await evalStep<{
        signedIn: boolean;
        challenge: AmazonAuthChallenge;
        currentUrl: string;
        orders: {
          retailerOrderId: string;
          asin: string | null;
          productTitle: string;
          imageUrl: string | null;
          totalCents: number | null;
          statusHeadline: string;
          trackingUrl: string | null;
        }[];
      }>((reqId) => buildScrapeYourOrdersScript(reqId));

      const syncedAt = Date.now();
      setLastSyncedAt(syncedAt);

      if (!scraped.signedIn) {
        setIsSignedIn(false);
        setChallenge(scraped.challenge);
        return {
          ok: false,
          requiresSignIn: true,
          purchases: purchasesRef.current,
          syncedAt,
          error: 'Sign in to Amazon to sync Your Orders and delivery dates.',
        };
      }

      setIsSignedIn(true);
      setChallenge('none');

      // Reconcile any previously `'unknown'` submissions observed in Your Orders
      submissionLedgerRef.current.reconcileFromSyncedOrders(
        scraped.orders.map((o) => ({
          retailerOrderId: o.retailerOrderId,
          asin: o.asin,
          syncedAt,
        })),
      );

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
        await navigateTo(trackable.trackingUrl);
        const detail = await evalStep<{
          primaryStatus: string | null;
          carrier: string | null;
          trackingNumber: string | null;
          events?: RawScrapedTrackingEvent[];
        }>((reqId) => buildScrapeProgressTrackerScript(reqId));
        trackerDetailsByOrderId.set(trackable.retailerOrderId, {
          primaryStatus: detail.primaryStatus,
          carrier: detail.carrier,
          trackingNumber: detail.trackingNumber,
          events: detail.events ?? [],
        });
      }

      const nextPurchasedMap: Record<string, CartItem> = { ...purchasedItemsRef.current };

      const nextPurchases: Purchase[] = scraped.orders.map((ord) => {
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
          placedAt: syncedAt - 3_600_000,
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

        if (convexSyncRef.current?.syncClientShipment) {
          void convexSyncRef.current
            .syncClientShipment(
              buildSyncClientShipmentArgs({
                orderRef,
                retailerOrderId: ord.retailerOrderId,
                shipment,
              }),
            )
            .catch(() => undefined);
        }

        nextPurchasedMap[itemId] = {
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
          placedAt: syncedAt,
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

      setPurchasedItems(nextPurchasedMap);
      purchasedItemsRef.current = nextPurchasedMap;
      setPurchases(nextPurchases);
      purchasesRef.current = nextPurchases;

      return {
        ok: true,
        requiresSignIn: false,
        purchases: nextPurchases,
        syncedAt,
      };
    });
  }, [enqueueCommand, evalStep, navigateTo]);

  const refreshCart = useCallback((): Promise<CartItem[]> => {
    return enqueueCommand(async () => {
      await navigateTo(AMAZON_CART_URL);
      const snap = await evalStep<{
        signedIn: boolean;
        challenge: AmazonAuthChallenge;
        items: ScrapedAmazonCartRow[];
      }>((reqId) => buildScrapeCartScript(reqId));
      setIsSignedIn(snap.signedIn);
      setChallenge(snap.challenge);
      return syncCartRowsToState(snap.items, Date.now());
    });
  }, [enqueueCommand, evalStep, navigateTo, syncCartRowsToState]);

  const refreshPurchases = useCallback(async (): Promise<Purchase[]> => {
    const res = await syncOrders();
    return res.purchases;
  }, [syncOrders]);

  useEffect(() => {
    let prevState: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      const returningToForeground =
        (prevState === 'background' || prevState === 'inactive') && nextState === 'active';
      prevState = nextState;

      if (!returningToForeground) return;
      const last = lastSyncedAtRef.current ?? 0;
      if (Date.now() - last < 15_000) return;

      if (isSignedInRef.current) {
        void syncOrders();
      } else {
        void refreshCart();
      }
    });
    return () => sub.remove();
  }, [refreshCart, syncOrders]);

  const listItems = useCallback(async (): Promise<CartItem[]> => {
    return [...itemsRef.current]
      .filter((i) => i.status === 'active')
      .sort((a, b) => b.addedAt - a.addedAt);
  }, []);

  const getItem = useCallback(async ({ itemId }: { itemId: string }): Promise<CartItem | null> => {
    return (
      itemsRef.current.find((i) => i.id === itemId) ??
      purchasedItemsRef.current[itemId] ??
      null
    );
  }, []);

  const addItem = useCallback(
    async (args: {
      url: string;
      variant?: string;
      reason?: string;
      quantity?: number;
      idempotencyKey: string;
    }) => {
      const existingId = idempotencyMapRef.current.get(args.idempotencyKey);
      if (existingId) {
        return { itemId: existingId, enrichmentStatus: 'enriching' as const, deduplicated: true };
      }
      const res = await addToCart({
        url: args.url,
        quantity: args.quantity,
        variantLabel: args.variant,
        reason: args.reason,
      });
      const itemId = res.addedItem?.id ?? `amz-item-${res.asin}`;
      idempotencyMapRef.current.set(args.idempotencyKey, itemId);
      return { itemId, enrichmentStatus: 'enriching' as const, deduplicated: false };
    },
    [addToCart],
  );

  const setQuantity = useCallback(
    async ({ itemId, quantity }: { itemId: string; quantity: number }): Promise<null> => {
      const clamped = Math.max(1, Math.min(10, Math.floor(quantity)));
      const target = itemsRef.current.find((i) => i.id === itemId);
      const asin = extractAsin(target?.url);
      if (!target || !asin) return null;

      await enqueueCommand(async () => {
        await navigateTo(AMAZON_CART_URL);
        const delta = clamped - target.quantity;
        const steps = Math.min(9, Math.abs(delta));
        for (let i = 0; i < steps; i += 1) {
          await evalStep((reqId) =>
            buildMutateCartRowScript(reqId, asin, delta > 0 ? 'increment' : 'decrement'),
          );
          await delay(1100);
        }
        const snap = await evalStep<{ items: ScrapedAmazonCartRow[] }>((reqId) =>
          buildScrapeCartScript(reqId),
        );
        syncCartRowsToState(snap.items, Date.now());
      });
      return null;
    },
    [enqueueCommand, evalStep, navigateTo, syncCartRowsToState],
  );

  const removeItem = useCallback(
    async ({ itemId }: { itemId: string }): Promise<null> => {
      const target = itemsRef.current.find((i) => i.id === itemId);
      const asin = extractAsin(target?.url);
      if (!asin) return null;

      await enqueueCommand(async () => {
        await navigateTo(AMAZON_CART_URL);
        const mutRes = await evalStep<{ mutated: boolean; reason?: string }>((reqId) =>
          buildMutateCartRowScript(reqId, asin, 'delete'),
        );
        if (!mutRes.mutated && mutRes.reason !== 'item_not_in_cart') {
          throw new Error(`Could not locate delete control for Amazon cart item ${asin}.`);
        }
        await delay(1400);
        const snap = await evalStep<{ items: ScrapedAmazonCartRow[] }>((reqId) =>
          buildScrapeCartScript(reqId),
        );
        syncCartRowsToState(snap.items, Date.now());
        if (snap.items.some((r) => r.asin.toUpperCase() === asin)) {
          throw new Error(`Failed to remove ${asin} from active Amazon cart.`);
        }
      });
      return null;
    },
    [enqueueCommand, evalStep, navigateTo, syncCartRowsToState],
  );

  const listPurchases = useCallback(async (): Promise<Purchase[]> => {
    return [...purchasesRef.current].sort((a, b) => (b.placedAt ?? 0) - (a.placedAt ?? 0));
  }, []);

  const requestPurchase = useCallback(
    async (args: {
      itemId: string;
      offerId: string;
      quantity: number;
      reason: string;
      idempotencyKey: string;
    }) => {
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
      setPendingRequests((prev) => [reqRecord, ...prev]);

      if (quoteRes.quote && !quoteRes.requiresSignIn && convexSyncRef.current?.attachClientQuote) {
        void convexSyncRef.current
          .attachClientQuote(
            buildAttachClientQuoteArgs({
              requestId,
              quoteVersion: 1,
              quote: quoteRes.quote,
            }),
          )
          .catch(() => undefined);
      }

      return {
        requestId,
        status: reqRecord.status,
        quoteVersion: 1,
        expiresAt,
        quote: quoteRes.quote,
      };
    },
    [getCheckoutQuote],
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
      const existing = pendingRequestsRef.current.find((r) => r.requestId === args.requestId);
      if (!existing) {
        throw new Error(`PurchaseRequest ${args.requestId} not found`);
      }
      if (existing.order?.status === 'placed') {
        return { outcome: 'already_approved', request: existing };
      }
      if (existing.order?.status === 'unknown') {
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
        setPendingRequests((prev) =>
          prev.map((r) => (r.requestId === args.requestId ? unknownReq : r)),
        );
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
          setPurchasedItems((prev) => ({
            ...prev,
            [targetItem.id]: { ...targetItem, status: 'purchased' },
          }));
          setItems((prev) => prev.filter((i) => i.id !== targetItem.id));
        }

        setPurchases((prev) => [newPurchase, ...prev]);
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
        setPendingRequests((prev) =>
          prev.map((r) => (r.requestId === args.requestId ? completedReq : r)),
        );
        return { outcome: 'approved', request: completedReq, orderResult };
      }

      return { outcome: 'invalid_state', request: existing, orderResult };
    },
    [placeOrder],
  );

  const status: AmazonSessionStatus =
    busyCount > 0 ? 'busy' : isSignedIn ? 'connected' : 'signed_out';

  const sessionValue = useMemo<AmazonSessionHookValue>(
    () => ({
      status,
      isSheetOpen,
      currentUrl,
      challenge,
      lastSyncedAt,
      openBrowserSheet,
      closeBrowserSheet,
      ensureSignedIn,
      checkSession,
      addToCart,
      getCheckoutQuote,
      placeOrder,
      syncOrders,
    }),
    [
      status,
      isSheetOpen,
      currentUrl,
      challenge,
      lastSyncedAt,
      openBrowserSheet,
      closeBrowserSheet,
      ensureSignedIn,
      checkSession,
      addToCart,
      getCheckoutQuote,
      placeOrder,
      syncOrders,
    ],
  );

  const adapterValue = useMemo<AmazonCartAdapterValue>(
    () => ({
      items,
      purchases,
      purchasedItems,
      pendingRequests,
      lastSyncedAt,
      listItems,
      getItem,
      addItem,
      setQuantity,
      removeItem,
      listPurchases,
      requestPurchase,
      decidePurchase,
      refreshCart,
      refreshPurchases,
    }),
    [
      items,
      purchases,
      purchasedItems,
      pendingRequests,
      lastSyncedAt,
      listItems,
      getItem,
      addItem,
      setQuantity,
      removeItem,
      listPurchases,
      requestPurchase,
      decidePurchase,
      refreshCart,
      refreshPurchases,
    ],
  );

  const contextValue = useMemo<CombinedAmazonContextValue>(
    () => ({ session: sessionValue, adapter: adapterValue }),
    [sessionValue, adapterValue],
  );

  const offscreenOffset = Math.max(dimensions.height * 2, 2400);

  return (
    <AmazonContext.Provider value={contextValue}>
      <View style={styles.root}>
        {children}

        {Platform.OS !== 'web' && (
          <View
            pointerEvents={isSheetOpen ? 'auto' : 'none'}
            accessibilityElementsHidden={!isSheetOpen}
            importantForAccessibility={isSheetOpen ? 'yes' : 'no-hide-descendants'}
            style={[
              styles.sheetOverlay,
              {
                width: dimensions.width,
                height: dimensions.height,
                paddingTop: insets.top,
                transform: [{ translateY: isSheetOpen ? 0 : offscreenOffset }],
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
                style={({ pressed }) => [styles.closeButton, pressed && styles.closeButtonPressed]}>
                <Text style={styles.closeButtonLabel}>Close</Text>
              </Pressable>
            </View>

            {isPageLoading && <View style={styles.loadingBar} />}

            <View style={styles.webViewFrame}>
              <WebView<Record<string, unknown>>
                ref={webViewRef}
                source={{ uri: AMAZON_CART_URL }}
                userAgent={Platform.OS === 'ios' ? IPHONE_SAFARI_USER_AGENT : undefined}
                sharedCookiesEnabled
                thirdPartyCookiesEnabled
                domStorageEnabled
                javaScriptEnabled
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
  );
}

export function useAmazonSession(): AmazonSessionHookValue {
  const ctx = useContext(AmazonContext);
  if (!ctx) {
    throw new Error('useAmazonSession must be used inside <AmazonBrowserProvider>.');
  }
  return ctx.session;
}

export function useAmazonCartAdapter(): AmazonCartAdapterValue {
  const ctx = useContext(AmazonContext);
  if (!ctx) {
    throw new Error('useAmazonCartAdapter must be used inside <AmazonBrowserProvider>.');
  }
  return ctx.adapter;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  sheetOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    zIndex: 9999,
    backgroundColor: Colors.background,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: Spacing.md,
    paddingHorizontal: Spacing.lg,
    paddingVertical: Spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.hairline,
    backgroundColor: Colors.background,
  },
  sheetSubtitle: {
    ...Type.secondary,
    flex: 1,
    color: Colors.textSecondary,
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
    color: Colors.text,
  },
  loadingBar: {
    height: 2,
    backgroundColor: Colors.accent,
  },
  webViewFrame: {
    flex: 1,
    backgroundColor: Colors.surface,
  },
  webView: {
    flex: 1,
  },
});
