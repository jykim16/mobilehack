import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { RetailerLogo } from '@/components/product-bits';
import { Colors, Spacing, Type, tabularNumbers } from '@/constants/theme';
import type { PriceComparison } from '@/data/types';
import { formatAgo, formatPrice } from '@/lib/format';

const pending = new Set<PriceComparison['status']>(['running', 'verifying']);

const retailerKey = (retailer: string) => retailer.toLowerCase().replace(/\W/g, '');

/**
 * Verified listings at other stores, with refused candidates muted beside their reason. It loads on its
 * own after the rest of the sheet, so it only ever shows a quiet progress line while the lookup runs.
 */
export function StoreComparison({
  comparison,
  savedPriceCents,
  demo,
}: {
  comparison: PriceComparison;
  savedPriceCents: number | null;
  demo: boolean;
}) {
  const [now] = useState(Date.now);
  const checking = pending.has(comparison.status);
  const priced = comparison.offers.filter((offer) => offer.priceCents !== null);
  const lowest = priced.reduce<number | null>((low, offer) => (low === null || offer.priceCents! < low ? offer.priceCents : low), null);
  const highlight = lowest !== null && savedPriceCents !== null && lowest < savedPriceCents ? lowest : null;
  const empty = comparison.offers.length === 0 && comparison.rejected.length === 0;

  return (
    <View style={styles.rows}>
      {comparison.offers.map((offer) => {
        const meta = [
          offer.seller !== offer.retailer ? offer.seller : null,
          offer.condition,
          offer.availability,
          offer.shippingCents ? `+${formatPrice(offer.shippingCents, offer.currency ?? 'USD')} shipping` : null,
          offer.verifiedAt ? `Checked ${formatAgo(offer.verifiedAt, now)}` : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          <Pressable
            key={offer.productUrl}
            accessibilityRole="link"
            onPress={() => WebBrowser.openBrowserAsync(offer.productUrl)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
            <RetailerLogo retailer={retailerKey(offer.retailer)} retailerName={offer.retailer} size={28} />
            <View style={styles.text}>
              <Text style={styles.store}>{offer.retailer}</Text>
              {meta.length > 0 && <Text style={styles.muted}>{meta}</Text>}
            </View>
            {offer.priceCents !== null && (
              <View style={styles.priceColumn}>
                <Text style={styles.price}>{formatPrice(offer.priceCents, offer.currency ?? 'USD')}</Text>
                {offer.priceCents === highlight && <Text style={styles.lowest}>Lowest</Text>}
              </View>
            )}
          </Pressable>
        );
      })}

      {comparison.rejected.map((candidate) => (
        <View key={candidate.productUrl} style={[styles.row, styles.rejected]}>
          <RetailerLogo retailer={retailerKey(candidate.retailer)} retailerName={candidate.retailer} size={28} />
          <View style={styles.text}>
            <Text style={styles.store}>{candidate.retailer}</Text>
            <Text style={styles.muted}>{candidate.reason}</Text>
          </View>
        </View>
      ))}

      {checking ? (
        <View style={styles.status}>
          <ActivityIndicator size="small" color={Colors.textSecondary} />
          <Text style={styles.muted}>{empty ? 'Checking other stores…' : 'Checking more stores…'}</Text>
        </View>
      ) : (
        empty && (
          <Text style={styles.muted}>
            {comparison.note ?? (comparison.status === 'failed' ? "Couldn't check other stores." : 'No other stores found.')}
          </Text>
        )
      )}
      {demo && <Text style={styles.footnote}>Demo prices</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  rows: { gap: Spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  pressed: { opacity: 0.6 },
  rejected: { opacity: 0.5 },
  text: { flex: 1, gap: 1 },
  store: { ...Type.body, fontWeight: '600', color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  priceColumn: { alignItems: 'flex-end' },
  price: { ...Type.body, ...tabularNumbers, fontWeight: '600', color: Colors.text },
  lowest: { ...Type.secondary, color: Colors.success },
  status: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  footnote: { ...Type.secondary, color: Colors.textTertiary },
});
