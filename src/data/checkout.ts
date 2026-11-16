import { useCallback, useRef } from 'react';
import { Platform } from 'react-native';

import { extractAsin, useAmazonSession, type AmazonPlaceOrderResult } from '@/amazon';

import { useShop } from './shop-store';
import type { CartItem } from './types';

export function useCheckout(): (item: CartItem) => Promise<void> {
  const { live, checkoutItem } = useShop();
  const { checkoutAmazonItem, openBrowserSheet } = useAmazonSession();
  const placing = useRef(new Set<string>());

  return useCallback(
    async (item: CartItem) => {
      const amazon = item.offer?.retailer === 'amazon' || extractAsin(item.url) !== null;
      if (!live || !amazon || Platform.OS === 'web') return checkoutItem(item);
      if (placing.current.has(item.id)) throw new Error('This order is already being placed.');
      placing.current.add(item.id);
      try {
        const result = await checkoutAmazonItem({ item, dryRun: true });
        if (result.status === 'requires_signin' && !/dismiss|closed|cancel/i.test(result.reason ?? '')) openBrowserSheet();
        if (result.status !== 'placed') throw new Error(amazonFailureMessage(result));
      } finally {
        placing.current.delete(item.id);
      }
    },
    [live, checkoutItem, checkoutAmazonItem, openBrowserSheet]
  );
}

function amazonFailureMessage({ status, reason }: AmazonPlaceOrderResult) {
  switch (status) {
    case 'requires_signin':
      return 'Finish signing in to Amazon to place this order.';
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
