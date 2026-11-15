import { makeFunctionReference } from 'convex/server';

import type { CartItem, DecideOutcome, Purchase, PurchaseRequest, ReviewList } from './types';

/**
 * References to the deployed Convex functions in api-contract.md, by name, so the app needs neither
 * the backend's convex/ folder nor its generated types. A backend rename is a one-line change here.
 */

type Empty = Record<string, never>;

export type RequestPurchaseResult = Pick<PurchaseRequest, 'requestId' | 'status' | 'quoteVersion' | 'expiresAt' | 'quote'>;

export interface AgentConnection {
  id: string;
  label: string;
  createdAt: number;
}

export const api = {
  cart: {
    listItems: makeFunctionReference<'query', Empty, CartItem[]>('cart:listItems'),
    getItem: makeFunctionReference<'query', { itemId: string }, CartItem>('cart:getItem'),
    addItem: makeFunctionReference<
      'mutation',
      { url: string; reason?: string; quantity?: number; idempotencyKey: string },
      { itemId: string; enrichmentStatus: 'resolving' | 'enriching'; deduplicated: boolean }
    >('cart:addItem'),
    setQuantity: makeFunctionReference<'mutation', { itemId: string; quantity: number }, null>('cart:setQuantity'),
    removeItem: makeFunctionReference<'mutation', { itemId: string }, null>('cart:removeItem'),
  },
  purchases: {
    requestPurchase: makeFunctionReference<
      'action',
      { itemId: string; offerId: string; quantity: number; reason: string; idempotencyKey: string },
      RequestPurchaseResult
    >('purchases:requestPurchase'),
    decidePurchase: makeFunctionReference<
      'mutation',
      { requestId: string; quoteVersion: number; decision: 'approve' | 'defer' },
      { outcome: DecideOutcome; request: PurchaseRequest }
    >('purchases:decidePurchase'),
    getPurchaseStatus: makeFunctionReference<'query', { requestId: string }, PurchaseRequest>('purchases:getPurchaseStatus'),
    listPurchases: makeFunctionReference<'query', Empty, Purchase[]>('purchases:listPurchases'),
  },
  reviews: {
    list: makeFunctionReference<'query', { cartItemId: string }, ReviewList>('reviews:list'),
  },
  demo: {
    setupMyCart: makeFunctionReference<'mutation', Empty, { heroUrl: string; airflyItemId: string }>('demo:setupMyCart'),
  },
  agentConnections: {
    create: makeFunctionReference<'mutation', { label: string }, { token: string }>('mcp/connection:create'),
    list: makeFunctionReference<'query', Empty, AgentConnection[]>('mcp/connection:listConnections'),
    revoke: makeFunctionReference<'mutation', { tokenId: string }, null>('mcp/connection:revokeConnection'),
  },
};

export const mcpUrl = process.env.EXPO_PUBLIC_CONVEX_SITE_URL
  ? `${process.env.EXPO_PUBLIC_CONVEX_SITE_URL.replace(/\/$/, '')}/mcp`
  : null;
