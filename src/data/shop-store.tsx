import { createContext, use, useCallback, useEffect, useState, type ReactNode } from 'react';

import * as assistantApi from './assistant-api';
import type { ChatMessage } from './assistant-api';
import * as cartApi from './cart-api';
import type { CartItem, Purchase } from './types';

/**
 * Screen-facing state. With Convex, each list becomes a useQuery subscription and refresh() goes away;
 * the actions keep their names and arguments.
 */

export type CartTab = 'cart' | 'purchases';

interface ShopState {
  ready: boolean;
  items: CartItem[];
  purchases: Purchase[];
  purchasedItems: Record<string, CartItem>;
  messages: ChatMessage[];
  assistantTyping: boolean;
  cartCount: number;
  cartTab: CartTab;
  setCartTab: (tab: CartTab) => void;
  refresh: () => Promise<void>;
  sendMessage: (text: string) => Promise<void>;
  addItem: (url: string) => Promise<void>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
}

const ShopContext = createContext<ShopState | null>(null);

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

let keyCounter = 0;
export const idempotencyKey = () => `app-${Date.now()}-${keyCounter++}`;

export function ShopProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [items, setItems] = useState<CartItem[]>([]);
  const [purchases, setPurchases] = useState<Purchase[]>([]);
  const [purchasedItems, setPurchasedItems] = useState<Record<string, CartItem>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [assistantTyping, setAssistantTyping] = useState(false);
  const [cartTab, setCartTab] = useState<CartTab>('cart');

  const apply = useCallback((snapshot: Snapshot) => {
    setItems(snapshot.items);
    setPurchases(snapshot.purchases);
    setPurchasedItems(snapshot.purchasedItems);
  }, []);

  const refresh = useCallback(async () => apply(await loadSnapshot()), [apply]);

  useEffect(() => {
    Promise.all([loadSnapshot(), assistantApi.getChatHistory()]).then(([snapshot, history]) => {
      apply(snapshot);
      setMessages(history);
      setReady(true);
    });
  }, [apply]);

  const value: ShopState = {
    ready,
    items,
    purchases,
    purchasedItems,
    messages,
    assistantTyping,
    cartCount: items.reduce((sum, item) => sum + item.quantity, 0),
    cartTab,
    setCartTab,
    refresh,
    sendMessage: async (text) => {
      setMessages((current) => [...current, { id: `pending-${current.length}`, role: 'user', text, createdAt: Date.now() }]);
      setAssistantTyping(true);
      setMessages(await assistantApi.sendChatMessage({ text }));
      setAssistantTyping(false);
    },
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
  };

  return <ShopContext value={value}>{children}</ShopContext>;
}

export function useShop() {
  const context = use(ShopContext);
  if (!context) throw new Error('useShop must be used inside ShopProvider');
  return context;
}

