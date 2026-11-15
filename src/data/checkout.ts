import { useShop } from './shop-store';
import type { CartItem } from './types';

/**
 * One-tap checkout for a cart item. Amazon offers (offer.retailer "amazon") are meant to go through
 * MOBI-7's useAmazonSession().checkoutAmazonItem({ item }) from src/amazon/ (JON-32), which signs in,
 * places the real order, and records it. Until that hook reaches main, every retailer uses the Convex
 * quote-and-approve path, so wiring it is a change to this one function.
 */
export function useCheckout(): (item: CartItem) => Promise<void> {
  return useShop().checkoutItem;
}
