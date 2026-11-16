import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatRelativeSyncTime, useAmazonCartAdapter, useAmazonSession } from '@/amazon';
import { ItemCard } from '@/components/item-card';
import { PillButton } from '@/components/pill-button';
import { RetailerHeader } from '@/components/retailer-header';
import { Radius, Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';
import { errorMessage, useShop } from '@/data/shop-store';
import type { Purchase } from '@/data/types';
import { etaDate, formatPrice, formatShortDate, isToday } from '@/lib/format';

export default function PurchasesScreen() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { ready, purchases: shopPurchases, purchasedItems, addItem } = useShop();
  const amazon = useAmazonCartAdapter();
  const { status, syncOrders } = useAmazonSession();
  const syncing = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const refresh = async () => {
    if (syncing.current || status !== 'connected') return;
    syncing.current = true;
    setRefreshing(true);
    setSyncError(null);
    try {
      const result = await syncOrders();
      if (!result.ok) setSyncError(result.error ?? 'Could not refresh Amazon tracking.');
    } catch (error) {
      setSyncError(errorMessage(error));
    } finally {
      syncing.current = false;
      setRefreshing(false);
    }
  };
  const amazonOrders = new Map(amazon.purchases.map((p) => [p.retailerOrderId, p]));
  const purchases = shopPurchases.map((p) => {
    const tracked = p.retailerOrderId ? amazonOrders.get(p.retailerOrderId) : undefined;
    return tracked?.shipment ? { ...p, shipment: tracked.shipment } : p;
  });

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <Text style={styles.title} accessibilityRole="header">
        Purchases
      </Text>
      {Platform.OS !== 'web' && (status === 'connected' || refreshing) && (
        <View style={styles.refresh}>
          <Text style={styles.meta}>Reads Amazon orders and saves delivery updates to Cart.</Text>
          <Pressable accessibilityRole="button" disabled={refreshing} onPress={refresh}>
            <Text style={styles.refreshAction}>{refreshing ? 'Refreshing…' : 'Refresh Amazon tracking'}</Text>
          </Pressable>
          {syncError && <Text style={styles.meta}>{syncError}</Text>}
        </View>
      )}
      {!ready ? null : purchases.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No purchases yet</Text>
          <Text style={styles.emptyBody}>Orders you check out show up here with their delivery status.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list} contentInsetAdjustmentBehavior="automatic">
          {purchases.map((purchase) => {
            const item = purchasedItems[purchase.itemId];
            const { quote } = purchase;
            return (
              <View key={purchase.orderId} style={styles.card}>
                <RetailerHeader
                  retailer={quote.retailer}
                  retailerName={quote.retailerName}
                  detail={purchase.placedAt ? `Ordered ${formatShortDate(purchase.placedAt)}` : 'Order placed'}
                />
                <ItemCard
                  title={quote.productTitle}
                  subtitle={quote.variantLabel}
                  imageUrl={quote.imageUrl}
                  onOpen={() => router.push({ pathname: '/purchase/[id]', params: { id: purchase.orderId } })}
                  footer={
                    item && (
                      <View style={styles.footer}>
                        <PillButton label="Buy again" size="small" onPress={() => addItem(item.url)} />
                      </View>
                    )
                  }>
                  <View style={styles.delivery}>
                    <Text style={[styles.status, purchase.shipment?.status === 'delivered' && styles.delivered]}>
                      {statusLine(purchase)}
                    </Text>
                    {purchase.retailerOrderId && amazonOrders.has(purchase.retailerOrderId) ? (
                      <Text style={styles.meta}>{formatRelativeSyncTime(amazon.lastSyncedAt)}</Text>
                    ) : null}
                    <Text style={styles.meta}>
                      {formatPrice(quote.totalCents, quote.currency)} total{purchase.simulated ? ' · Simulated checkout' : ''}
                    </Text>
                  </View>
                </ItemCard>
              </View>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

function statusLine({ status, shipment }: Purchase) {
  if (status === 'submitting') return 'Placing order';
  if (status === 'failed') return 'Order failed';
  if (status === 'requote_required') return 'Price changed · Review it in your cart';
  if (status === 'unknown') return 'Checking order status';
  if (!shipment) return 'Order placed';
  const eta = shipment.eta ? etaDate(shipment.eta) : null;
  switch (shipment.status) {
    case 'ordered':
      return eta ? `Order placed · Arrives ${formatShortDate(eta)}` : 'Order placed';
    case 'shipped':
      return eta ? `Shipped · Arrives ${formatShortDate(eta)}` : 'Shipped';
    case 'out_for_delivery':
      return eta && isToday(eta) ? 'Out for delivery · Arriving today' : 'Out for delivery';
    case 'delivered':
      return eta ? `Delivered ${formatShortDate(eta)}` : 'Delivered';
  }
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  title: { ...Type.title, color: Colors.text, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  list: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, paddingBottom: Spacing.xxl, gap: Spacing.md },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.xl },
  footer: { flexDirection: 'row', justifyContent: 'flex-end' },
  delivery: { gap: 2, marginTop: Spacing.sm },
  status: { ...Type.body, fontWeight: '600', color: Colors.text },
  delivered: { color: Colors.success },
  meta: { ...Type.secondary, color: Colors.textSecondary },
  refresh: { paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md, gap: Spacing.sm },
  refreshAction: { ...Type.secondary, fontWeight: '600', color: Colors.accent },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl, gap: Spacing.sm },
  emptyTitle: { ...Type.title, color: Colors.text },
  emptyBody: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
});
