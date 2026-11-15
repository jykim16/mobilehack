import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PillButton } from '@/components/pill-button';
import { ProductImage } from '@/components/product-bits';
import { Colors, Radius, Spacing, Type, tabularNumbers } from '@/constants/theme';
import { errorMessage, useShop, type PendingQuote } from '@/data/shop-store';
import { formatPrice } from '@/lib/format';

export default function CheckoutSheet() {
  const insets = useSafeAreaInsets();
  const { items: itemParam } = useLocalSearchParams<{ items: string }>();
  const { ready, items, quoteItem, decide: decidePurchase, setCartTab } = useShop();
  const [requests, setRequests] = useState<PendingQuote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    const itemIds = (itemParam ?? '').split(',').filter(Boolean);
    const selected = items.filter((item) => itemIds.includes(item.id));
    Promise.all(
      selected.length ? selected.map(quoteItem) : [Promise.reject(new Error('This item is no longer in your cart.'))]
    )
      .then(setRequests)
      .catch((e: unknown) => setError(errorMessage(e)));
  }, [ready, itemParam, items, quoteItem]);

  const decide = async (decision: 'approve' | 'defer') => {
    if (!requests) return;
    setBusy(true);
    setNotice(null);
    try {
      const results = await Promise.all(requests.map((r) => decidePurchase(r, decision)));
      const remaining: PendingQuote[] = [];
      let message: string | null = null;
      for (const { outcome, request } of results) {
        if (outcome === 'stale_quote' && request.quote) {
          remaining.push({ requestId: request.requestId, quoteVersion: request.quoteVersion, quote: request.quote });
          message = 'The price changed since this quote. Review the new total.';
        } else if (outcome === 'expired' && decision === 'approve') {
          const item = items.find((i) => i.id === request.itemId);
          if (item) remaining.push(await quoteItem({ ...item, pendingRequest: null }));
          message = 'That quote expired, so here is a fresh one.';
        } else if (outcome === 'invalid_state') {
          message = 'This item can no longer be bought. It may have been removed or already purchased.';
        }
      }
      if (message) {
        if (remaining.length === 0) setError(message);
        setRequests(remaining.length ? remaining : null);
        setNotice(remaining.length ? message : null);
        setBusy(false);
        return;
      }
      if (decision === 'approve') setCartTab('purchases');
      router.back();
    } catch (e) {
      setNotice(errorMessage(e));
      setBusy(false);
    }
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
        {notice && <Text style={styles.notice}>{notice}</Text>}
        <PillButton
          variant="accent"
          label={busy ? 'Placing order…' : `Approve · ${formatPrice(total)}`}
          disabled={busy}
          onPress={() => decide('approve')}
        />
        <Pressable accessibilityRole="button" hitSlop={8} onPress={() => decide('defer')} disabled={busy}>
          {({ pressed }) => <Text style={[styles.notNow, pressed && { color: Colors.text }]}>Not now</Text>}
        </Pressable>
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
  notice: { ...Type.secondary, color: Colors.text, textAlign: 'center' },
  footnote: { ...Type.secondary, color: Colors.textTertiary, textAlign: 'center' },
});
