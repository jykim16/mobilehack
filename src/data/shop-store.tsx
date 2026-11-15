import { useAction, useConvex, useMutation, useQueries, useQuery } from 'convex/react';
import { ConvexError } from 'convex/values';
import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import { convexConfigured, useSession } from '@/lib/session';

import * as assistantApi from './assistant-api';
import type { ChatMessage } from './assistant-api';
import * as cartApi from './cart-api';
import { api } from './convex-api';
import type { CartItem, DecideOutcome, Purchase, PurchaseRequest, Quote } from './types';

/**
 * Screen-facing state. With EXPO_PUBLIC_CONVEX_URL set, lists are live useQuery subscriptions on the
 * deployed backend for the anonymous shopper; without it, the same state comes from the in-memory mocks
 * so the app still runs offline. Screens only see ShopState.
 */

export type CartTab = 'cart' | 'purchases';

export interface PendingQuote {
  requestId: string;
  quoteVersion: number;
  quote: Quote;
}

type Decision = 'approve' | 'defer';
type DecideResult = { outcome: DecideOutcome; request: PurchaseRequest };

interface ShopState {
  live: boolean;
  ready: boolean;
  error: string | null;
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
  messages: ChatMessage[];
  assistantTyping: boolean;
  cartCount: number;
  cartTab: CartTab;
  setCartTab: (tab: CartTab) => void;
  sendMessage: (text: string) => Promise<void>;
  addItem: (url: string) => Promise<void>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  loadDemoCart: () => Promise<void>;
  quoteItem: (item: CartItem) => Promise<PendingQuote>;
  decide: (request: PendingQuote, decision: Decision) => Promise<DecideResult>;
}

const ShopContext = createContext<ShopState | null>(null);

let keyCounter = 0;
export const idempotencyKey = () => `app-${Date.now()}-${keyCounter++}`;

export function errorMessage(error: unknown) {
  if (error instanceof ConvexError && typeof error.data?.message === 'string') return error.data.message as string;
  if (error instanceof Error && !error.message.includes('[Request ID')) return error.message;
  return 'Something went wrong. Try again.';
}

function toPending(result: Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'quote'>): PendingQuote {
  if (result.status !== 'pending_approval' || !result.quote) throw new Error('This item could not be quoted right now.');
  return { requestId: result.requestId, quoteVersion: result.quoteVersion, quote: result.quote };
}

const purchaseArgs = (item: CartItem) => {
  if (!item.offer) throw new Error('This item has no price yet.');
  return {
    itemId: item.id,
    offerId: item.offer.id,
    quantity: item.quantity,
    reason: 'Bought from the Cart app',
    idempotencyKey: idempotencyKey(),
  };
};

function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantTyping, setAssistantTyping] = useState(false);

  useEffect(() => {
    assistantApi.getChatHistory().then(setMessages);
  }, []);

  const sendMessage = async (text: string) => {
    setMessages((current) => [...current, { id: `pending-${current.length}`, role: 'user', text, createdAt: Date.now() }]);
    setAssistantTyping(true);
    setMessages(await assistantApi.sendChatMessage({ text }));
    setAssistantTyping(false);
  };

  return { messages, assistantTyping, sendMessage };
}

const countOf = (items: CartItem[]) => items.reduce((sum, item) => sum + item.quantity, 0);

function LiveShopProvider({ children }: { children: ReactNode }) {
  const session = useSession();
  const signedIn = session === 'signed_in';
  const chat = useChat();
  const [cartTab, setCartTab] = useState<CartTab>('cart');
  const convex = useConvex();

  const items = useQuery(api.cart.listItems, signedIn ? {} : 'skip');
  const purchases = useQuery(api.purchases.listPurchases, signedIn ? {} : 'skip');
  const details = useQueries(
    Object.fromEntries(
      (purchases ?? []).map((p) => [p.itemId, { query: api.cart.getItem, args: { itemId: p.itemId } }])
    )
  );
  const purchasedItems: Record<string, CartItem> = {};
  for (const [itemId, detail] of Object.entries(details)) {
    if (detail && !(detail instanceof Error)) purchasedItems[itemId] = detail as CartItem;
  }

  const addItem = useMutation(api.cart.addItem);
  const setQuantity = useMutation(api.cart.setQuantity);
  const removeItem = useMutation(api.cart.removeItem);
  const setupMyCart = useMutation(api.demo.setupMyCart);
  const requestPurchase = useAction(api.purchases.requestPurchase);
  const decidePurchase = useMutation(api.purchases.decidePurchase);

  const value: ShopState = {
    live: true,
    ready: items !== undefined && purchases !== undefined,
    error: null,
    items: items ?? [],
    purchases: purchases ?? [],
    purchasedItems,
    ...chat,
    cartCount: countOf(items ?? []),
    cartTab,
    setCartTab,
    addItem: async (url) => {
      await addItem({ url, idempotencyKey: idempotencyKey() });
    },
    setQuantity: async (itemId, quantity) => {
      await setQuantity({ itemId, quantity });
    },
    removeItem: async (itemId) => {
      await removeItem({ itemId });
    },
    loadDemoCart: async () => {
      await setupMyCart({});
    },
    quoteItem: async (item) => {
      const pending = item.pendingRequest;
      if (pending && pending.expiresAt > Date.now()) {
        const request = await convex.query(api.purchases.getPurchaseStatus, { requestId: pending.requestId });
        if (request.status === 'pending_approval' && request.quote) return toPending(request);
      }
      return toPending(await requestPurchase(purchaseArgs(item)));
    },
    decide: ({ requestId, quoteVersion }, decision) => decidePurchase({ requestId, quoteVersion, decision }),
  };

  return <ShopContext value={value}>{children}</ShopContext>;
}

interface Snapshot {
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
}

async function loadSnapshot(): Promise<Snapshot> {
  const [items, purchases] = await Promise.all([cartApi.listItems(), cartApi.listPurchases()]);
  const details = await Promise.all(purchases.map((p) => cartApi.getItem({ itemId: p.itemId })));
  return { items, purchases, purchasedItems: Object.fromEntries(details.map((item) => [item.id, item])) };
}

function MockShopProvider({ children }: { children: ReactNode }) {
  const chat = useChat();
  const [cartTab, setCartTab] = useState<CartTab>('cart');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  const refresh = useCallback(async () => setSnapshot(await loadSnapshot()), []);

  useEffect(() => {
    loadSnapshot().then(setSnapshot);
  }, []);

  const value: ShopState = {
    live: false,
    ready: snapshot !== null,
    error: null,
    items: snapshot?.items ?? [],
    purchases: snapshot?.purchases ?? [],
    purchasedItems: snapshot?.purchasedItems ?? {},
    ...chat,
    cartCount: countOf(snapshot?.items ?? []),
    cartTab,
    setCartTab,
    addItem: async (url) => {
      await cartApi.addItem({ url, idempotencyKey: idempotencyKey() });
      await refresh();
    },
    setQuantity: async (itemId, quantity) => {
      await cartApi.setQuantity({ itemId, quantity });
      await refresh();
    },
    removeItem: async (itemId) => {
      await cartApi.removeItem({ itemId });
      await refresh();
    },
    loadDemoCart: refresh,
    quoteItem: async (item) => toPending(await cartApi.requestPurchase(purchaseArgs(item))),
    decide: async ({ requestId, quoteVersion }, decision) => {
      const result = await cartApi.decidePurchase({ requestId, quoteVersion, decision });
      await refresh();
      return result;
    },
  };

  return <ShopContext value={value}>{children}</ShopContext>;
}

export const ShopProvider = convexConfigured ? LiveShopProvider : MockShopProvider;

export function useShop() {
  const context = use(ShopContext);
  if (!context) throw new Error('useShop must be used inside ShopProvider');
  return context;
}

function useLiveItem(itemId: string): CartItem | undefined {
  const signedIn = useSession() === 'signed_in';
  return useQuery(api.cart.getItem, signedIn && itemId ? { itemId } : 'skip');
}

function useMockItem(itemId: string): CartItem | undefined {
  const [item, setItem] = useState<CartItem>();
  useEffect(() => {
    cartApi.getItem({ itemId }).then(setItem);
  }, [itemId]);
  return item;
}

/** One cart item with full sections and price history, kept live on Convex. */
export const useItem = convexConfigured ? useLiveItem : useMockItem;
