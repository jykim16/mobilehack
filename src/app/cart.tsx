import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ItemCard } from '@/components/item-card';
import { PillButton } from '@/components/pill-button';
import { PriceText, RetailerLogo } from '@/components/product-bits';
import { QuantityStepper } from '@/components/quantity-stepper';
import { SegmentedControl } from '@/components/segmented-control';
import { Colors, Radius, Spacing, Type, tabularNumbers } from '@/constants/theme';
import { useShop } from '@/data/shop-store';
import type { CartItem, Shipment } from '@/data/types';
import { etaDate, formatPrice, formatShortDate, isToday } from '@/lib/format';

export default function CartScreen() {
  const insets = useSafeAreaInsets();
  const { ready, cartTab, setCartTab } = useShop();

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to chat"
          hitSlop={8}
          onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          style={({ pressed }) => [styles.back, pressed && { backgroundColor: Colors.control }]}>
          <Ionicons name="chevron-back" size={22} color={Colors.text} />
        </Pressable>
        <SegmentedControl
          value={cartTab}
          onChange={setCartTab}
          segments={[
            { value: 'cart', label: 'Cart' },
            { value: 'purchases', label: 'Purchases' },
          ]}
        />
      </View>

      {!ready ? null : cartTab === 'cart' ? <CartTab bottomInset={insets.bottom} /> : <PurchasesTab bottomInset={insets.bottom} />}
    </View>
  );
}

function checkout(itemIds: string[]) {
  router.push({ pathname: '/checkout', params: { items: itemIds.join(',') } });
}

function CartTab({ bottomInset }: { bottomInset: number }) {
  const { items, setQuantity, removeItem } = useShop();

  if (items.length === 0) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Your cart is empty</Text>
        <Text style={styles.emptyBody}>Ask the assistant to find something, and add it from the chat.</Text>
        <PillButton label="Back to chat" onPress={() => router.back()} style={styles.emptyButton} />
      </View>
    );
  }

  const groups = groupByRetailer(items);
  const total = items.reduce((sum, item) => sum + (item.price?.subtotalCents ?? 0), 0);
  const count = items.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <>
      <ScrollView contentContainerStyle={[styles.list, { paddingBottom: 120 + bottomInset }]}>
        {groups.map(({ retailer, retailerName, deliveryEstimate, items: groupItems }) => (
          <View key={retailer} style={styles.card}>
            <RetailerHeader retailer={retailer} retailerName={retailerName} detail={deliveryEstimate} />
            {groupItems.map((item) => (
              <ItemCard
                key={item.id}
                itemId={item.id}
                title={item.product?.title ?? item.url}
                subtitle={item.variant?.label ?? null}
                imageUrl={item.product?.imageUrl}
                rating={item.rating}
                actionLabel="Buy"
                actionVariant="strong"
                onAction={() => checkout([item.id])}>
                {item.price && (
                  <View style={styles.priceRow}>
                    <PriceText priceCents={item.price.currentCents} listPriceCents={item.price.listPriceCents} />
                    <QuantityStepper
                      quantity={item.quantity}
                      onChange={(quantity) => setQuantity(item.id, quantity)}
                      onRemove={() => removeItem(item.id)}
                    />
                  </View>
                )}
              </ItemCard>
            ))}
            {(groupItems.length > 1 || groupItems[0].quantity > 1) && (
              <View style={styles.subtotal}>
                <Text style={styles.subtotalLabel}>Subtotal</Text>
                <Text style={styles.subtotalValue}>
                  {formatPrice(groupItems.reduce((sum, item) => sum + (item.price?.subtotalCents ?? 0), 0))}
                </Text>
              </View>
            )}
          </View>
        ))}
      </ScrollView>
      <View style={[styles.checkoutBar, { paddingBottom: Math.max(bottomInset, Spacing.lg) }]}>
        <PillButton
          variant="accent"
          icon="cart"
          label={`Checkout all (${count}) · ${formatPrice(total)}`}
          onPress={() => checkout(items.map((item) => item.id))}
        />
      </View>
    </>
  );
}

function PurchasesTab({ bottomInset }: { bottomInset: number }) {
  const { purchases, purchasedItems, addItem } = useShop();
  return (
    <ScrollView contentContainerStyle={[styles.list, { paddingBottom: Spacing.xxl + bottomInset }]}>
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
              itemId={purchase.itemId}
              title={quote.productTitle}
              subtitle={quote.variantLabel}
              imageUrl={quote.imageUrl}
              rating={item?.rating ?? null}
              actionLabel="Buy again"
              actionVariant="secondary"
              onAction={() => item && addItem(item.url)}>
              <View style={styles.delivery}>
                <Text style={[styles.status, purchase.shipment?.status === 'delivered' && styles.delivered]}>
                  {statusLine(purchase.shipment)}
                </Text>
                <Text style={styles.orderMeta}>{formatPrice(quote.totalCents, quote.currency)} total</Text>
                <Text style={styles.orderMeta}>{quote.returnSummary}</Text>
              </View>
            </ItemCard>
          </View>
        );
      })}
    </ScrollView>
  );
}

function RetailerHeader({ retailer, retailerName, detail }: { retailer: string; retailerName: string; detail: string }) {
  return (
    <View style={styles.retailer}>
      <RetailerLogo retailer={retailer} retailerName={retailerName} size={36} />
      <View>
        <Text style={styles.retailerName}>{retailerName}</Text>
        <Text style={styles.retailerDetail}>{detail}</Text>
      </View>
    </View>
  );
}

function groupByRetailer(items: CartItem[]) {
  const groups: { retailer: string; retailerName: string; deliveryEstimate: string; items: CartItem[] }[] = [];
  for (const item of items) {
    const retailer = item.offer?.retailer ?? 'unknown';
    const group = groups.find((g) => g.retailer === retailer);
    if (group) group.items.push(item);
    else
      groups.push({
        retailer,
        retailerName: item.offer?.retailerName ?? 'Other store',
        deliveryEstimate: item.offer?.deliveryEstimate ?? '',
        items: [item],
      });
  }
  return groups;
}

function statusLine(shipment: Shipment | null) {
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

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  header: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md, paddingHorizontal: Spacing.lg, paddingBottom: Spacing.md },
  back: {
    width: 40,
    height: 40,
    borderRadius: Radius.pill,
    backgroundColor: Colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  list: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.md },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.xl },
  retailer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  retailerName: { ...Type.headline, color: Colors.text },
  retailerDetail: { ...Type.secondary, color: Colors.textSecondary },
  priceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: Spacing.sm },
  subtotal: { flexDirection: 'row', justifyContent: 'space-between' },
  subtotalLabel: { ...Type.body, color: Colors.textSecondary },
  subtotalValue: { ...Type.body, ...tabularNumbers, fontWeight: '600', color: Colors.text },
  checkoutBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing.lg,
    paddingTop: Spacing.md,
    backgroundColor: Colors.background,
  },
  delivery: { gap: 2, marginTop: Spacing.sm },
  status: { ...Type.body, fontWeight: '600', color: Colors.text },
  delivered: { color: Colors.success },
  orderMeta: { ...Type.secondary, color: Colors.textSecondary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl, gap: Spacing.sm },
  emptyTitle: { ...Type.title, color: Colors.text },
  emptyBody: { ...Type.body, color: Colors.textSecondary, textAlign: 'center' },
  emptyButton: { marginTop: Spacing.lg },
});
