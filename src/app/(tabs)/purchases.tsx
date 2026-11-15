import { router } from 'expo-router';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ItemCard } from '@/components/item-card';
import { PillButton } from '@/components/pill-button';
import { RetailerHeader } from '@/components/retailer-header';
import { Radius, Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';
import { useShop } from '@/data/shop-store';
import type { Purchase } from '@/data/types';
import { etaDate, formatPrice, formatShortDate, isToday } from '@/lib/format';

export default function PurchasesScreen() {
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { ready, purchases, purchasedItems, addItem } = useShop();

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <Text style={styles.title} accessibilityRole="header">
        Purchases
      </Text>
      {!ready ? null : purchases.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>No purchases yet</Text>
          <Text style={styles.emptyBody}>Orders you check out show up here with their delivery status.</Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl, gap: Spacing.sm },
  emptyTitle: { ...Type.title, color: Colors.text },
  emptyBody: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
});
