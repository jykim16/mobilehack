import { type ConvexReactClient, useConvex, useConvexAuth, useQuery } from 'convex/react';
import { makeFunctionReference } from 'convex/server';
import React, { Component, useCallback, useEffect, useMemo, useRef } from 'react';
import { AppState, Platform } from 'react-native';

import {
  type AttachClientQuoteArgs,
  buildAttachClientQuoteArgs,
  type ConvexAmazonSyncClient,
  type RecordClientPlacementArgs,
  type SyncClientShipmentArgs,
} from './convex-sync';
import { type AmazonDaemonBridgeValue, useAmazonDaemonBridge } from './daemon-bridge-context';
import {
  type ConvexCheckoutCoordinator,
  DAEMON_POLL_INTERVAL_MS,
  executeCartSyncPlan,
  hasActiveUndeliveredAmazonOrders,
  ORDER_SYNC_INTERVAL_MS,
  planConvexCartSyncActions,
  planPendingApprovalQuotes,
  SerializedAsyncRunner,
  shouldPollOrderDeliverySync,
} from './daemon-engine';
import type { CartItem, DecideOutcome, Purchase, PurchaseRequest, Quote } from './types';

type EmptyArgs = Record<string, never>;

type AsConvexArgs<T> = { [K in keyof T]: T[K] };

/**
 * Self-contained Convex function references matching `convex/cart.ts`,
 * `convex/purchases.ts`, and `convex/orders.ts` (`api-contract.md`) without
 * importing `convex/_generated/*`.
 */
export const amazonConvexApi = {
  cart: {
    listItems: makeFunctionReference<'query', EmptyArgs, CartItem[]>('cart:listItems'),
    getItem: makeFunctionReference<'query', { itemId: string }, CartItem>('cart:getItem'),
  },
  purchases: {
    listPendingApprovals: makeFunctionReference<'query', EmptyArgs, PurchaseRequest[]>(
      'purchases:listPendingApprovals',
    ),
    listPurchases: makeFunctionReference<'query', EmptyArgs, Purchase[]>(
      'purchases:listPurchases',
    ),
    getPurchaseStatus: makeFunctionReference<'query', { requestId: string }, PurchaseRequest>(
      'purchases:getPurchaseStatus',
    ),
    requestPurchase: makeFunctionReference<
      'action',
      {
        itemId: string;
        offerId: string;
        quantity: number;
        reason: string;
        idempotencyKey: string;
      },
      Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'expiresAt' | 'quote'>
    >('purchases:requestPurchase'),
    attachClientQuote: makeFunctionReference<
      'mutation',
      AsConvexArgs<AttachClientQuoteArgs>,
      { quoteVersion: number; quote: Quote }
    >('purchases:attachClientQuote'),
    decidePurchase: makeFunctionReference<
      'mutation',
      { requestId: string; quoteVersion: number; decision: 'approve' | 'defer' },
      { outcome: DecideOutcome; request: PurchaseRequest }
    >('purchases:decidePurchase'),
  },
  orders: {
    recordClientPlacement: makeFunctionReference<
      'mutation',
      AsConvexArgs<RecordClientPlacementArgs>,
      { status: 'placed' | 'already_recorded'; orderRef: string; retailerOrderId: string }
    >('orders:recordClientPlacement'),
    syncClientShipment: makeFunctionReference<
      'mutation',
      AsConvexArgs<SyncClientShipmentArgs>,
      { updated: boolean; orderRef: string }
    >('orders:syncClientShipment'),
  },
};

class DaemonAuthBoundary extends Component<
  { children: React.ReactNode },
  { disabled: boolean }
> {
  override state = { disabled: false };

  static getDerivedStateFromError(): { disabled: true } {
    return { disabled: true };
  }

  override render() {
    if (this.state.disabled) return null;
    return this.props.children;
  }
}

export interface AmazonSyncDaemonProps {
  enabled?: boolean;
  pollIntervalMs?: number;
  orderSyncIntervalMs?: number;
}

/**
 * Automatic background Convex <-> WebKit/Chromium synchronization daemon.
 *
 * Safely skips execution when mounted outside `<ConvexProvider>` / `<ConvexAuthProvider>`
 * or on web, and otherwise runs:
 * 1. Continuous `2500ms` polling + reactive `useQuery` subscriptions on `api.cart.listItems`
 *    & `api.purchases.listPendingApprovals` so Muse MCP agent items (`addedBy === 'agent'`)
 *    and quantity updates deterministically mutate the real `amazon.com` cart.
 * 2. Re-verification/re-sync of active Convex Amazon cart items whenever `isSignedIn`
 *    transitions from `false` -> `true`.
 * 3. Live SPC dry-run quote attachment (`api.purchases.attachClientQuote`) for pending
 *    Amazon approvals whose quote is still simulated.
 * 4. Automatic `syncOrders()` polling every `30s` and on `AppState -> active` while signed
 *    in with active non-delivered orders, pushing carrier & `eta` updates via `syncClientShipment`.
 */
export function AmazonSyncDaemon({
  enabled = true,
  pollIntervalMs = DAEMON_POLL_INTERVAL_MS,
  orderSyncIntervalMs = ORDER_SYNC_INTERVAL_MS,
}: AmazonSyncDaemonProps) {
  const bridge = useAmazonDaemonBridge();
  // `useConvex()` returns `undefined` at runtime when no `<ConvexProvider>` ancestor is mounted.
  const convex = useConvex() as ConvexReactClient | undefined;

  if (!enabled || !bridge || !convex || Platform.OS === 'web') {
    return null;
  }

  return (
    <DaemonAuthBoundary>
      <AmazonSyncDaemonActive
        convex={convex}
        bridge={bridge}
        pollIntervalMs={pollIntervalMs}
        orderSyncIntervalMs={orderSyncIntervalMs}
      />
    </DaemonAuthBoundary>
  );
}

function AmazonSyncDaemonActive({
  convex,
  bridge,
  pollIntervalMs,
  orderSyncIntervalMs,
}: {
  convex: ConvexReactClient;
  bridge: AmazonDaemonBridgeValue;
  pollIntervalMs: number;
  orderSyncIntervalMs: number;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const canQuery = isAuthenticated && !isLoading;

  const reactiveCartItems = useQuery(
    amazonConvexApi.cart.listItems,
    canQuery ? {} : 'skip',
  );
  const reactivePendingApprovals = useQuery(
    amazonConvexApi.purchases.listPendingApprovals,
    canQuery ? {} : 'skip',
  );
  const reactivePurchases = useQuery(
    amazonConvexApi.purchases.listPurchases,
    canQuery ? {} : 'skip',
  );

  const reactiveCartRef = useRef<CartItem[] | undefined>(reactiveCartItems);
  const reactiveApprovalsRef = useRef<PurchaseRequest[] | undefined>(reactivePendingApprovals);
  const reactivePurchasesRef = useRef<Purchase[] | undefined>(reactivePurchases);
  const lastOrderSyncAtRef = useRef(0);
  const attemptedQuoteMapRef = useRef<Map<string, number>>(new Map());
  const runnerRef = useRef<SerializedAsyncRunner>(new SerializedAsyncRunner());

  useEffect(() => {
    reactiveCartRef.current = reactiveCartItems;
  }, [reactiveCartItems]);

  useEffect(() => {
    reactiveApprovalsRef.current = reactivePendingApprovals;
  }, [reactivePendingApprovals]);

  useEffect(() => {
    reactivePurchasesRef.current = reactivePurchases;
    if (reactivePurchases) {
      bridge.noteKnownConvexPurchases(reactivePurchases);
    }
  }, [bridge, reactivePurchases]);

  const autoSyncClient = useMemo<ConvexAmazonSyncClient>(
    () => ({
      attachClientQuote: async (args) => {
        await convex.mutation(amazonConvexApi.purchases.attachClientQuote, args);
      },
      recordClientPlacement: async (args) => {
        await convex.mutation(amazonConvexApi.orders.recordClientPlacement, args);
      },
      syncClientShipment: async (args) => {
        await convex.mutation(amazonConvexApi.orders.syncClientShipment, args);
      },
    }),
    [convex],
  );

  const autoCheckoutCoordinator = useMemo<ConvexCheckoutCoordinator>(
    () => ({
      findPendingApprovalForItem: async (itemId) => {
        const cached = reactiveApprovalsRef.current?.find(
          (r) =>
            r.itemId === itemId &&
            (r.status === 'pending_approval' || r.status === 'quoting'),
        );
        if (cached) return cached;
        const approvals = await convex.query(amazonConvexApi.purchases.listPendingApprovals, {});
        return (
          approvals.find(
            (r) =>
              r.itemId === itemId &&
              (r.status === 'pending_approval' || r.status === 'quoting'),
          ) ?? null
        );
      },
      findExistingOrderForItem: async (itemId) => {
        const matchOrder = (list: Purchase[]) =>
          list.find(
            (p) =>
              p.itemId === itemId &&
              (p.status === 'placed' ||
                p.status === 'awaiting_client' ||
                p.status === 'submitting' ||
                p.status === 'unknown'),
          ) ?? null;
        const cached = reactivePurchasesRef.current
          ? matchOrder(reactivePurchasesRef.current)
          : null;
        if (cached) return cached;
        const purchases = await convex.query(amazonConvexApi.purchases.listPurchases, {});
        return matchOrder(purchases);
      },
      requestPurchase: (args) =>
        convex.action(amazonConvexApi.purchases.requestPurchase, args),
      getPurchaseStatus: (args) =>
        convex.query(amazonConvexApi.purchases.getPurchaseStatus, args),
      attachClientQuote: (args) =>
        convex.mutation(amazonConvexApi.purchases.attachClientQuote, args),
      decidePurchase: (args) =>
        convex.mutation(amazonConvexApi.purchases.decidePurchase, args),
    }),
    [convex],
  );

  useEffect(() => {
    if (!canQuery) {
      bridge.registerAutoConvexBridge({
        syncClient: undefined,
        checkoutCoordinator: undefined,
      });
      return;
    }
    bridge.registerAutoConvexBridge({
      syncClient: autoSyncClient,
      checkoutCoordinator: autoCheckoutCoordinator,
    });
    return () => {
      bridge.registerAutoConvexBridge({
        syncClient: undefined,
        checkoutCoordinator: undefined,
      });
    };
  }, [autoCheckoutCoordinator, autoSyncClient, bridge, canQuery]);

  const runDaemonPass = useCallback(
    async (mode: 'poll' | 'reactive' | 'foreground') => {
      if (!canQuery) return;
      if (bridge.isResetting() || bridge.isCheckoutInFlight()) return;
      // Never yank the WebView away while the shopper has the sign-in sheet open
      if (bridge.isSheetOpen()) return;

      const ledger = bridge.getSyncedCartLedger();
      await ledger.hydrate(bridge.getShopperId());

      let activeItems: CartItem[] = reactiveCartRef.current ?? [];
      let pendingApprovals: PurchaseRequest[] = reactiveApprovalsRef.current ?? [];

      if (
        mode === 'poll' ||
        mode === 'foreground' ||
        reactiveCartRef.current === undefined ||
        reactiveApprovalsRef.current === undefined
      ) {
        const [itemsPoll, approvalsPoll] = await Promise.allSettled([
          convex.query(amazonConvexApi.cart.listItems, {}),
          convex.query(amazonConvexApi.purchases.listPendingApprovals, {}),
        ]);
        if (itemsPoll.status === 'fulfilled') {
          activeItems = itemsPoll.value;
        }
        if (approvalsPoll.status === 'fulfilled') {
          pendingApprovals = approvalsPoll.value;
        }
      }

      if (bridge.isResetting() || bridge.isCheckoutInFlight() || bridge.isSheetOpen()) {
        return;
      }

      // 1. Muse MCP & Convex Cart -> Deterministic Amazon WebView Add-to-Cart / Qty / Sign-in Resync
      const signedInNow = bridge.isSignedIn();
      const cartActions = planConvexCartSyncActions({
        activeItems,
        ledger,
        isSignedIn: signedInNow,
        now: Date.now(),
      });

      if (cartActions.length > 0) {
        await executeCartSyncPlan({
          actions: cartActions,
          ledger,
          isSignedIn: signedInNow,
          shouldAbort: () =>
            bridge.isResetting() || bridge.isCheckoutInFlight() || bridge.isSheetOpen(),
          addToCart: bridge.addToCart,
          setQuantity: bridge.setQuantity,
          refreshCart: bridge.refreshCart,
        });
      }

      if (bridge.isResetting() || bridge.isCheckoutInFlight() || bridge.isSheetOpen()) {
        return;
      }

      // 2. Pending Purchase Approval Live Quote Attachment (when signed in)
      if (bridge.isSignedIn() && pendingApprovals.length > 0) {
        const knownById = new Map(activeItems.map((i) => [i.id, i]));
        for (const req of pendingApprovals) {
          if (!knownById.has(req.itemId)) {
            try {
              const fetchedItem = await convex.query(amazonConvexApi.cart.getItem, {
                itemId: req.itemId,
              });
              if (fetchedItem) knownById.set(fetchedItem.id, fetchedItem);
            } catch {
              // Ignore removed or inaccessible items
            }
          }
        }

        const quoteActions = planPendingApprovalQuotes({
          pendingApprovals,
          activeItems: Array.from(knownById.values()),
          isSignedIn: bridge.isSignedIn(),
          now: Date.now(),
          attemptedQuoteMap: attemptedQuoteMapRef.current,
        });

        for (const qa of quoteActions) {
          if (bridge.isResetting() || bridge.isCheckoutInFlight() || bridge.isSheetOpen()) {
            break;
          }
          const attemptKey = `${qa.requestId}:${qa.quoteVersion}`;
          attemptedQuoteMapRef.current.set(attemptKey, Date.now());

          const itemMeta = knownById.get(qa.itemId);
          const quoteRes = await bridge.quoteSingleItem({
            asin: qa.asin,
            url: qa.url,
            quantity: qa.quantity,
            productTitle: itemMeta?.product?.title,
            seller: itemMeta?.offer?.seller,
            imageUrl: itemMeta?.product?.imageUrl ?? null,
            variantLabel: itemMeta?.variant?.label ?? null,
            returnSummary: itemMeta?.offer?.returnSummary,
          });

          if (quoteRes.ok && quoteRes.quote && !quoteRes.requiresSignIn) {
            await bridge.enqueueQuoteSync(
              buildAttachClientQuoteArgs({
                requestId: qa.requestId,
                quoteVersion: qa.quoteVersion,
                quote: quoteRes.quote,
              }),
            );
          }
        }
      }

      if (bridge.isResetting() || bridge.isCheckoutInFlight() || bridge.isSheetOpen()) {
        return;
      }

      // 3. Delivery Status Sync (`syncOrders` -> `api.orders.syncClientShipment`)
      if (bridge.isSignedIn()) {
        let convexPurchases = reactivePurchasesRef.current ?? [];
        if (mode === 'foreground' || reactivePurchasesRef.current === undefined) {
          try {
            convexPurchases = await convex.query(amazonConvexApi.purchases.listPurchases, {});
            bridge.noteKnownConvexPurchases(convexPurchases);
          } catch {
            // Fall back to cached purchases
          }
        }

        const allPurchases = [...convexPurchases, ...bridge.localPurchasesReactive];
        const hasUndelivered = hasActiveUndeliveredAmazonOrders(allPurchases);
        const now = Date.now();
        const shouldSyncOrders =
          (mode === 'foreground' && hasUndelivered) ||
          shouldPollOrderDeliverySync({
            isSignedIn: bridge.isSignedIn(),
            hasUndeliveredOrders: hasUndelivered,
            lastOrderSyncAt: lastOrderSyncAtRef.current,
            now,
            intervalMs: orderSyncIntervalMs,
          });

        if (shouldSyncOrders) {
          lastOrderSyncAtRef.current = now;
          await bridge.syncOrders();
        }
      }
    },
    [bridge, canQuery, convex, orderSyncIntervalMs],
  );

  // Wake immediately on reactive Convex changes or Amazon `isSignedIn` / `shopperId` transitions
  useEffect(() => {
    if (!canQuery) return;
    void runnerRef.current.trigger(() => runDaemonPass('reactive'));
  }, [
    canQuery,
    reactiveCartItems,
    reactivePendingApprovals,
    bridge.isSignedInReactive,
    bridge.shopperIdReactive,
    runDaemonPass,
  ]);

  // Continuous 2500ms backend polling loop
  useEffect(() => {
    if (!canQuery) return;
    const timer = setInterval(() => {
      if (AppState.currentState && AppState.currentState !== 'active') return;
      void runnerRef.current.trigger(() => runDaemonPass('poll'));
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [canQuery, pollIntervalMs, runDaemonPass]);

  // Immediate wakeup on AppState -> active
  useEffect(() => {
    if (!canQuery) return;
    let prevState: string | null | undefined = AppState.currentState;
    const sub = AppState.addEventListener('change', (nextState) => {
      const returningToForeground =
        (prevState === 'background' || prevState === 'inactive') && nextState === 'active';
      prevState = nextState;
      if (returningToForeground) {
        void runnerRef.current.trigger(() => runDaemonPass('foreground'));
      }
    });
    return () => sub.remove();
  }, [canQuery, runDaemonPass]);

  return null;
}
