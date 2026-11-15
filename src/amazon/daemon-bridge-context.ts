import { createContext, useContext } from 'react';

import type {
  AttachClientQuoteArgs,
  ConvexAmazonSyncClient,
  SyncClientShipmentArgs,
} from './convex-sync';
import type {
  ConvexCheckoutCoordinator,
  SyncedCartLedger,
} from './daemon-engine';
import type {
  AmazonAddToCartInput,
  AmazonAddToCartResult,
  AmazonCheckoutQuoteResult,
  AmazonSyncOrdersResult,
  CartItem,
  Purchase,
} from './types';

export interface AmazonDaemonBridgeValue {
  hasCustomConvexSync: boolean;
  registerAutoConvexBridge: (bridge: {
    syncClient: ConvexAmazonSyncClient | undefined;
    checkoutCoordinator: ConvexCheckoutCoordinator | undefined;
  }) => void;
  getSyncedCartLedger: () => SyncedCartLedger;
  getShopperId: () => string | null;
  isSignedIn: () => boolean;
  isSheetOpen: () => boolean;
  isResetting: () => boolean;
  isCheckoutInFlight: () => boolean;
  isSignedInReactive: boolean;
  shopperIdReactive: string | null;
  localPurchasesReactive: Purchase[];
  noteKnownConvexPurchases: (purchases: Purchase[]) => void;
  addToCart: (input: AmazonAddToCartInput) => Promise<AmazonAddToCartResult>;
  setQuantity: (args: { itemId: string; quantity: number }) => Promise<null>;
  refreshCart: () => Promise<CartItem[]>;
  quoteSingleItem: (params: {
    asin: string;
    url: string;
    quantity: number;
    productTitle?: string;
    seller?: string;
    imageUrl?: string | null;
    variantLabel?: string | null;
    returnSummary?: string;
  }) => Promise<AmazonCheckoutQuoteResult>;
  syncOrders: () => Promise<AmazonSyncOrdersResult>;
  enqueueQuoteSync: (args: AttachClientQuoteArgs) => Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }>;
  enqueueShipmentSync: (args: SyncClientShipmentArgs) => Promise<{
    synced: number;
    remaining: number;
    lastSyncError: string | null;
  }>;
}

export const AmazonDaemonBridgeContext = createContext<AmazonDaemonBridgeValue | null>(null);

export function useAmazonDaemonBridge(): AmazonDaemonBridgeValue | null {
  return useContext(AmazonDaemonBridgeContext);
}
