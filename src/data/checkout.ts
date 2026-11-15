import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import { extractAsin, useAmazonSession, type AmazonPlaceOrderResult } from '@/amazon';

import { useShop } from './shop-store';
import type { CartItem } from './types';

/**
 * One-tap checkout for a cart item. In the live app on iOS and Android, Amazon items go through
 * useAmazonSession().checkoutAmazonItem, which signs in when needed, places the real Amazon order in the
 * background browser, and records it in Convex. Every other item, and every item on web or in the offline
 * demo, uses the Convex quote-and-approve path. Amazon orders are real money: one attempt per tap, never
 * retried, and a second tap on the same item while one is in flight is refused.
 */
export function useCheckout(): (item: CartItem) => Promise<void> {
  const { live, checkoutItem } = useShop();
  const { checkoutAmazonItem } = useAmazonSession();
  const placing = useRef(new Set<string>());

  return useCallback(
    async (item: CartItem) => {
      const amazon = item.offer?.retailer === 'amazon' || extractAsin(item.url) !== null;
      if (!live || !amazon || Platform.OS === 'web') return checkoutItem(item);
      if (placing.current.has(item.id)) throw new Error('This order is already being placed.');
      placing.current.add(item.id);
      try {
        const result = await checkoutAmazonItem({ item });
        if (result.status !== 'placed') throw new Error(amazonFailureMessage(result));
      } finally {
        placing.current.delete(item.id);
      }
    },
    [live, checkoutItem, checkoutAmazonItem]
  );
}

function amazonFailureMessage({ status, reason }: AmazonPlaceOrderResult) {
  switch (status) {
    case 'requires_signin':
      return 'Sign in to Amazon to place this order.';
    case 'requote_required':
      return 'The Amazon price changed. Check the item and try again.';
    case 'basket_mismatch':
      return 'Your Amazon cart has other items in it. Clear them on Amazon and try again.';
    case 'unknown':
      return 'Amazon did not confirm the order yet. Check Purchases before trying again.';
    case 'dry_run_halted':
      return 'Stopped before placing the Amazon order.';
    default:
      return reason ?? 'Amazon could not place this order.';
  }
}
