import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '@/components/pill-button';
import { ProductImage } from '@/components/product-bits';
import { Colors, Radius, Spacing, Type, tabularNumbers } from '@/constants/theme';
import { decidePurchase, getItem, requestPurchase } from '@/data/cart-api';
import { idempotencyKey, useShop } from '@/data/shop-store';
import type { Quote } from '@/data/types';
import { formatPrice } from '@/lib/format';

interface PendingRequest {
  requestId: string;
  quoteVersion: number;
  quote: Quote;
}

export default function CheckoutSheet() {
  const insets = useSafeAreaInsets();
  const { items: itemParam } = useLocalSearchParams<{ items: string }>();
  const { refresh, setCartTab } = useShop();
  const [requests, setRequests] = useState<PendingRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    const itemIds = (itemParam ?? '').split(',').filter(Boolean);
    Promise.all(
      itemIds.map(async (itemId) => {
        const item = await getItem({ itemId });
        const result = await requestPurchase({
          itemId,
          offerId: item.offer!.id,
          quantity: item.quantity,
          reason: 'Bought from the Cart app',
          idempotencyKey: idempotencyKey(),
        });
        return { requestId: result.requestId, quoteVersion: result.quoteVersion, quote: result.quote! };
      })
    )
      .then(setRequests)
      .catch((e: Error) => setError(e.message));
  }, [itemParam]);

  const decide = async (decision: 'approve' | 'defer') => {
    if (!requests) return;
    setApproving(decision === 'approve');
    const results = await Promise.all(
      requests.map((r) => decidePurchase({ requestId: r.requestId, quoteVersion: r.quoteVersion, decision }))
    );
    await refresh();
    if (decision === 'defer') return router.back();
    const placed = results.filter((r) => r.outcome === 'approved' || r.outcome === 'already_approved');
    if (placed.length === results.length) {
      setCartTab('purchases');
      return router.back();
    }
    setApproving(false);
    setRequests(requests.filter((_, i) => !placed.includes(results[i])));
    setError(
      results.some((r) => r.outcome === 'expired')
        ? 'This quote expired, so nothing was ordered. Close and tap Buy again for a fresh quote.'
        : 'The price changed, so nothing was ordered. Close and tap Buy again for a fresh quote.'
    );
  };

  if (!requests) {
    return (
      <View style={styles.loading}>
        {error ? <Text style={styles.muted}>{error}</Text> : <ActivityIndicator color={Colors.textSecondary} />}
        <Text style={styles.muted}>{error ? '' : 'Getting a quote'}</Text>
      </View>
    );
  }

  const sum = (key: 'subtotalCents' | 'taxCents' | 'shippingCents' | 'totalCents') =>
    requests.reduce((total, r) => total + r.quote[key], 0);
  const total = sum('totalCents');
  const shipping = sum('shippingCents');

  return (
    <View style={styles.sheet}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>Review order</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={() => router.back()} style={styles.close}>
            <Ionicons name="close" size={18} color={Colors.text} />
          </Pressable>
        </View>

        <View style={styles.lines}>
          {requests.map(({ requestId, quote }) => (
            <View key={requestId} style={styles.line}>
              <ProductImage imageUrl={quote.imageUrl} size={56} />
              <View style={styles.lineText}>
                <Text style={styles.lineTitle} numberOfLines={1}>
                  {quote.productTitle}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {quote.retailerName} · Qty {quote.quantity}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {quote.deliveryEstimate}
                </Text>
                <Text style={styles.muted} numberOfLines={1}>
                  {quote.returnSummary}
                </Text>
              </View>
              <Text style={styles.linePrice}>{formatPrice(quote.subtotalCents, quote.currency)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.breakdown}>
          <Row label="Subtotal" value={formatPrice(sum('subtotalCents'))} />
          <Row label="Estimated tax" value={formatPrice(sum('taxCents'))} />
          <Row label="Shipping" value={shipping === 0 ? 'Free' : formatPrice(shipping)} />
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatPrice(total)}</Text>
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, Spacing.lg) }]}>
        <PillButton
          variant="accent"
          label={approving ? 'Placing order…' : `Approve · ${formatPrice(total)}`}
          disabled={approving || error !== null}
          onPress={() => decide('approve')}
        />
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => decide('defer')} disabled={approving}>
          {({ pressed }) => <Text style={[styles.notNow, pressed && { color: Colors.text }]}>Not now</Text>}
        </Pressable>
        {error && <Text style={styles.error}>{error}</Text>}
        {requests.some((r) => r.quote.simulated) && (
          <Text style={styles.footnote}>Simulated checkout. No payment is taken.</Text>
        )}
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: Spacing.sm, backgroundColor: Colors.surface },
  sheet: { flex: 1, backgroundColor: Colors.surface },
  content: { padding: Spacing.xxl, paddingTop: Spacing.xxxl, gap: Spacing.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { ...Type.title, color: Colors.text },
  close: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  lines: { gap: Spacing.lg },
  line: { flexDirection: 'row', gap: Spacing.md, alignItems: 'flex-start' },
  lineText: { flex: 1, gap: 1 },
  lineTitle: { ...Type.body, fontWeight: '600', color: Colors.text },
  linePrice: { ...Type.body, ...tabularNumbers, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  breakdown: { gap: Spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between' },
  rowLabel: { ...Type.body, color: Colors.textSecondary },
  rowValue: { ...Type.body, ...tabularNumbers, color: Colors.text },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm },
  totalLabel: { ...Type.headline, color: Colors.text },
  totalValue: { ...Type.headline, ...tabularNumbers, color: Colors.text },
  footer: { paddingHorizontal: Spacing.xxl, paddingTop: Spacing.md, gap: Spacing.md, alignItems: 'stretch' },
  notNow: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
  footnote: { ...Type.secondary, color: Colors.textTertiary, textAlign: 'center' },
  error: { ...Type.secondary, color: Colors.text, textAlign: 'center' },
});
