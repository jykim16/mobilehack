import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { CloseButton, DetailSection, PaymentRows, ReceiptRows } from '@/components/order-details';
import { ProductImage, RatingText, RetailerLogo } from '@/components/product-bits';
import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { useItem, usePurchaseRequest } from '@/data/shop-store';
import { formatShortDate } from '@/lib/format';

export default function ItemDetails() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);
  const request = usePurchaseRequest(item?.pendingRequest?.requestId);
  const quote = request?.status === 'pending_approval' ? request.quote : null;

  if (!item) {
    return (
      <View style={[styles.screen, styles.loading]}>
        <ActivityIndicator color={Colors.textSecondary} />
      </View>
    );
  }

  const { offer, price } = item;

  return (
    <View style={[styles.screen, { paddingTop: insets.top + Spacing.sm }]}>
      <View style={styles.header}>
        <CloseButton />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + Spacing.xxxl }]}>
        <View style={styles.hero}>
          <ProductImage imageUrl={item.product?.imageUrl} size={240} />
        </View>

        <View style={styles.titleBlock}>
          <Text style={styles.title}>{item.product?.title ?? item.url}</Text>
          {item.variant && <Text style={styles.muted}>{item.variant.label}</Text>}
          {offer && (
            <View style={styles.retailer}>
              <RetailerLogo retailer={offer.retailer} retailerName={offer.retailerName} size={20} />
              <Text style={styles.muted}>
                {offer.retailerName} · {offer.deliveryEstimate}
              </Text>
            </View>
          )}
          <RatingText rating={item.rating} onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: item.id } })} />
        </View>

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
                : 'Estimate. The final total is confirmed when you review the order.'}
            </Text>
          </DetailSection>
        )}

        <DetailSection title="Payment and delivery">
          <PaymentRows />
        </DetailSection>

        {offer && <Text style={styles.footnote}>{offer.returnSummary}</Text>}
      </ScrollView>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  screen: { flex: 1, backgroundColor: Colors.background },
  loading: { alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', paddingHorizontal: Spacing.lg, paddingBottom: Spacing.sm },
  content: { paddingHorizontal: Spacing.lg, paddingTop: Spacing.sm, gap: Spacing.xxl },
  hero: { alignItems: 'center', backgroundColor: Colors.imageTile, borderRadius: Radius.card, paddingVertical: Spacing.lg },
  titleBlock: { gap: Spacing.xs },
  title: { ...Type.title, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  retailer: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm, marginVertical: Spacing.xs },
  footnote: { ...Type.secondary, color: Colors.textTertiary },
});
