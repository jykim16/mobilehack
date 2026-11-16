import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseButton, DetailSection, PaymentRows, ReceiptRows } from '@/components/order-details';
import { PriceHistoryChart } from '@/components/price-history-chart';
import { PriceText, ProductImage, RatingText, RetailerLogo } from '@/components/product-bits';
import { ReviewPreview } from '@/components/review-preview';
import { StoreComparison } from '@/components/store-comparison';
import { Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { alternativeLine, resolveItemOffer } from '@/data/offer-identity';
import { itemComparison, useItem, usePurchaseRequest } from '@/data/shop-store';
import type { CartItem, Offer, Price, PriceHistory } from '@/data/types';
import { formatAgo, formatPrice, formatShortDate } from '@/lib/format';

const STALE_MS = 24 * 60 * 60 * 1000;

export default function ItemDetails() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);
  const request = usePurchaseRequest(item?.pendingRequest?.requestId);
  const quote = request?.status === 'pending_approval' ? request.quote : null;
  const [now] = useState(Date.now);

  if (!item) {
    return (
      <View style={[styles.screen, styles.loading]}>
        <ActivityIndicator color={Colors.textSecondary} />
      </View>
    );
  }

  const { priceHistory } = item;
  const { offer, checkoutOffer, alternative } = resolveItemOffer(item);
  const price = offer ? estimate(item, offer) : null;
  const store = offer ?? item.offer;
  const availability = item.offerAvailability?.note;
  const { comparison, demo } = itemComparison(item);

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.header}>
        <CloseButton />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        <View style={styles.product}>
          <ProductImage imageUrl={item.product?.imageUrl} size={88} />
          <View style={styles.productText}>
            <Text style={styles.title} numberOfLines={3}>
              {item.product?.title ?? item.url}
            </Text>
            {item.variant && <Text style={styles.muted}>{item.variant.label}</Text>}
            {store && (
              <View style={styles.retailer}>
                <RetailerLogo retailer={store.retailer} retailerName={store.retailerName} size={18} />
                <Text style={styles.muted} numberOfLines={1}>
                  {store.retailerName} · {store.deliveryEstimate}
                </Text>
              </View>
            )}
            <RatingText rating={item.rating} onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: item.id } })} />
          </View>
        </View>

        {availability && <Text style={styles.muted}>{availability}</Text>}
        {!checkoutOffer && alternative && <Text style={styles.muted}>{alternativeLine(alternative)}</Text>}

        {offer && (
          <DetailSection title="Price history">
            <View>
              <PriceText priceCents={offer.priceCents} listPriceCents={offer.listPriceCents} />
              <Text style={styles.muted}>
                Item price from {offer.retailerName}&apos;s listing · checked {formatAgo(offer.updatedAt, now)}
                {now - offer.updatedAt > STALE_MS ? ' · may be out of date' : ''}
              </Text>
              {priceHistory && !priceHistory.trackingSinceAdded && <Text style={styles.muted}>{historyLine(priceHistory)}</Text>}
            </View>
            {priceHistory?.trackingSinceAdded ? (
              <Text style={styles.muted}>Tracking since added. Cart charts this price as it changes.</Text>
            ) : priceHistory && priceHistory.points.length >= 2 ? (
              <PriceHistoryChart
                points={priceHistory.points}
                sampled={priceHistory.sampled ?? false}
                caption={priceHistory.sampled ? 'Sampled from Keepa' : (priceHistory.seriesLabel ?? null)}
              />
            ) : (
              <Text style={styles.muted}>Not enough price history yet.</Text>
            )}
          </DetailSection>
        )}

        <ReviewPreview item={item} />

        {comparison && (
          <DetailSection title="Other stores">
            <StoreComparison comparison={comparison} savedPriceCents={offer?.priceCents ?? null} demo={demo} />
          </DetailSection>
        )}

        {(quote || price) && (
          <DetailSection title="Purchase details">
            {quote ? (
              <ReceiptRows
                unitCents={quote.unitPriceCents}
                listPriceCents={price?.listPriceCents ?? null}
                quantity={quote.quantity}
                subtotalCents={quote.subtotalCents}
                taxCents={quote.taxCents}
                shippingCents={quote.shippingCents}
                totalCents={quote.totalCents}
                currency={quote.currency}
              />
            ) : (
              price && (
                <ReceiptRows
                  unitCents={price.currentCents}
                  listPriceCents={price.listPriceCents}
                  quantity={item.quantity}
                  subtotalCents={price.subtotalCents}
                  taxCents={price.taxCents}
                  shippingCents={price.shippingCents}
                  totalCents={price.totalCents}
                  currency={price.currency}
                />
              )
            )}
            <Text style={styles.footnote}>
              {quote
                ? `Quoted by ${quote.retailerName} ${formatShortDate(quote.quotedAt)}.`
                : 'Estimate. The final total is set when you check out.'}
            </Text>
          </DetailSection>
        )}

        <DetailSection title="Payment and delivery">
          <PaymentRows />
        </DetailSection>

        {store && <Text style={styles.footnote}>{store.returnSummary}</Text>}
      </ScrollView>
    </View>
  );
}

/** The saved estimate when Cart prices the saved offer; for a swapped-in new offer, the same tax rate applied to its price. */
function estimate(item: CartItem, offer: Offer): Price | null {
  const saved = item.price;
  if (!saved) return null;
  if (offer.id === item.offer?.id) return saved;
  const subtotalCents = offer.priceCents * item.quantity;
  const taxCents = saved.subtotalCents > 0 ? Math.round((subtotalCents * saved.taxCents) / saved.subtotalCents) : 0;
  return {
    ...saved,
    currentCents: offer.priceCents,
    listPriceCents: offer.listPriceCents,
    subtotalCents,
    taxCents,
    shippingCents: offer.shippingCents,
    totalCents: subtotalCents + taxCents + offer.shippingCents,
  };
}

function historyLine({ points, lowCents, highCents, currentCents, note }: PriceHistory) {
  if (points.length < 2) return '';
  const days = Math.round((points[points.length - 1].observedAt - points[0].observedAt) / 86_400_000);
  if (lowCents === null || highCents === null) return note ?? `${points.length} prices over ${days} days`;
  if (currentCents <= lowCents) return `Lowest price in ${days} days`;
  if (highCents > currentCents) return `${formatPrice(highCents - currentCents)} below its ${days}-day high`;
  return `At its ${days}-day high`;
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  loading: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xxl },
  product: { flexDirection: 'row', gap: Spacing.lg },
  productText: { flex: 1, gap: 2 },
  title: { ...Type.headline, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  retailer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginVertical: 2 },
  footnote: { ...Type.secondary, color: Colors.textTertiary },
});
