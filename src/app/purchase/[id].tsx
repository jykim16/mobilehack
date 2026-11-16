import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseButton, DetailRow, DetailSection, PaymentRows, ReceiptRows } from '@/components/order-details';
import { ProductImage, RatingText } from '@/components/product-bits';
import { ShipmentTimeline, shipmentProgress } from '@/components/shipment-timeline';
import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { mockShipmentEvents } from '@/data/mock-shipment';
import { checkoutResult } from '@/data/checkout-status';
import { usePurchaseRequest, useShop } from '@/data/shop-store';
import type { Purchase } from '@/data/types';
import { etaDate, formatShortDate, isToday } from '@/lib/format';

export default function PurchaseDetails() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { ready, purchases, purchasedItems } = useShop();
  const purchase = purchases.find((p) => p.orderId === id);
  const request = usePurchaseRequest(purchase?.requestId);

  if (!purchase) {
    return (
      <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
        <View style={styles.header}>
          <CloseButton />
        </View>
        <View style={styles.loading}>
          {ready ? (
            <Text style={styles.muted}>This order is no longer in Purchases. If it failed or its price changed, review it in your cart.</Text>
          ) : (
            <ActivityIndicator color={Colors.textSecondary} />
          )}
        </View>
      </View>
    );
  }

  const { quote } = purchase;
  const item = purchasedItems[purchase.itemId];
  const placedAt = purchase.placedAt;
  const shipment = request?.shipment ?? purchase.shipment;
  const demoEvents = Boolean(shipment && !shipment.events?.length && placedAt);
  const events = shipment?.events?.length
    ? shipment.events
    : shipment && placedAt
      ? mockShipmentEvents(placedAt, quote.retailer, shipment)
      : [];
  const { newest, label } = shipmentProgress(shipment, events);
  const eta = shipment?.eta ? etaDate(shipment.eta) : null;
  const deliveredOn = newest?.occurredAt ?? eta;
  const confirmed = checkoutResult(purchase) === 'placed';
  const title = confirmed ? label : orderTitles[purchase.status] ?? 'Order not confirmed';
  const subtitle =
    shipment?.status === 'delivered'
      ? deliveredOn
        ? `Delivered ${formatShortDate(deliveredOn)}`
        : null
      : eta
        ? isToday(eta)
          ? 'Arriving today'
          : `Arrives ${formatShortDate(eta)}`
        : null;
  const trackingUrl = shipment?.trackingUrl;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.header}>
        <CloseButton />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>{title}</Text>
          {confirmed && subtitle && <Text style={styles.muted}>{subtitle}</Text>}
        </View>

        {confirmed && (
          <View style={styles.card}>
            <ShipmentTimeline placedAt={placedAt} shipment={shipment} events={events} />
            {shipment?.carrier && shipment.trackingNumber && (
              <Pressable
                accessibilityRole={trackingUrl ? 'link' : 'text'}
                disabled={!trackingUrl}
                onPress={() => trackingUrl && WebBrowser.openBrowserAsync(trackingUrl)}>
                <Text style={styles.muted}>
                  {shipment.carrier} · Tracking <Text style={styles.tracking}>{shipment.trackingNumber}</Text>
                </Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.product}>
          <ProductImage imageUrl={quote.imageUrl} size={64} />
          <View style={styles.productText}>
            <Text style={styles.productTitle} numberOfLines={2}>
              {quote.productTitle}
            </Text>
            <Text style={styles.muted} numberOfLines={1}>
              {[quote.variantLabel, quote.retailerName].filter(Boolean).join(' · ')}
            </Text>
            <RatingText
              rating={item?.rating ?? null}
              onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: purchase.itemId } })}
            />
          </View>
        </View>

        <DetailSection title="Purchase details">
          <View style={styles.rows}>
            <DetailRow label="Order" value={purchase.orderRef} />
            {placedAt && <DetailRow label="Placed" value={formatShortDate(placedAt)} />}
          </View>
          <ReceiptRows
            unitCents={quote.unitPriceCents}
            listPriceCents={item?.price?.listPriceCents ?? null}
            quantity={quote.quantity}
            subtotalCents={quote.subtotalCents}
            taxCents={quote.taxCents}
            shippingCents={quote.shippingCents}
            totalCents={quote.totalCents}
            currency={quote.currency}
          />
        </DetailSection>

        <DetailSection title="Payment and delivery">
          <PaymentRows />
        </DetailSection>

        <View style={styles.notes}>
          <Text style={styles.footnote}>{quote.returnSummary}</Text>
          {(purchase.simulated || demoEvents) && (
            <Text style={styles.footnote}>
              {[purchase.simulated && 'Simulated checkout', demoEvents && 'Demo tracking events'].filter(Boolean).join(' · ')}
            </Text>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const orderTitles: Partial<Record<Purchase['status'], string>> = {
  awaiting_payment: 'Payment required · No order placed',
  awaiting_client: 'Order not confirmed',
  submitting: 'Placing order',
  unknown: 'Checking order status',
  requote_required: 'Price changed',
  failed: 'Order failed',
};

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Spacing.xxxl },
  header: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xxl },
  titleBlock: { gap: Spacing.xs },
  title: { ...Type.title, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  tracking: { color: Colors.text },
  card: { backgroundColor: Colors.surface, borderRadius: Radius.card, padding: Spacing.lg, gap: Spacing.xl },
  product: { flexDirection: 'row', gap: Spacing.md, alignItems: 'center' },
  productText: { flex: 1, gap: 2 },
  productTitle: { ...Type.body, fontWeight: '600', color: Colors.text },
  rows: { gap: Spacing.md },
  notes: { gap: Spacing.xs },
  footnote: { ...Type.secondary, color: Colors.textTertiary },
});
