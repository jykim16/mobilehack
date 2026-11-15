import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { PriceChart } from '@/components/price-chart';
import { RetailerLogo } from '@/components/product-bits';
import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { useItem } from '@/data/shop-store';
import { formatPrice } from '@/lib/format';

export default function PriceHistorySheet() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);

  const history = item?.priceHistory;
  if (!item || !history || history.points.length < 2) {
    return (
      <View style={styles.loading}>
        {item ? <Text style={styles.muted}>No price history yet</Text> : <ActivityIndicator color={Colors.textSecondary} />}
      </View>
    );
  }

  const { lowCents, highCents, currentCents, points } = history;
  const days = Math.round((points[points.length - 1].observedAt - points[0].observedAt) / 86_400_000);
  const belowHigh = highCents - currentCents;
  const otherOffers = item.offers.filter((offer) => offer.id !== item.offer?.id);

  return (
    <ScrollView style={styles.sheet} contentContainerStyle={styles.content}>
      <View style={styles.titleRow}>
        <View style={styles.titleText}>
          <Text style={styles.product} numberOfLines={2}>
            {item.product?.title}
          </Text>
          <Text style={styles.muted}>
            {item.offer?.retailerName} · last {days} days{points.some((p) => p.simulated) ? ' · Demo data' : ''}
          </Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={() => router.back()} style={styles.close}>
          <Ionicons name="close" size={18} color={Colors.text} />
        </Pressable>
      </View>

      <View>
        <Text style={styles.current}>{formatPrice(currentCents)}</Text>
        <Text style={styles.muted}>
          {currentCents <= lowCents
            ? `Lowest price in ${days} days`
            : belowHigh > 0
              ? `${formatPrice(belowHigh)} below its ${days}-day high`
              : `At its ${days}-day high`}
        </Text>
      </View>

      <PriceChart points={points} />

      <View style={styles.stats}>
        <Stat label="Lowest" value={lowCents} />
        <Stat label="Highest" value={highCents} />
        <Stat label="Current" value={currentCents} />
      </View>

      {otherOffers.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Other stores</Text>
          {otherOffers.map((offer) => (
            <View key={offer.id} style={styles.storeRow}>
              <RetailerLogo retailer={offer.retailer} retailerName={offer.retailerName} size={28} />
              <Text style={styles.storeName}>{offer.retailerName}</Text>
              <Text style={styles.storePrice}>{formatPrice(offer.priceCents, offer.currency)}</Text>
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.stat}>
      <Text style={styles.muted}>{label}</Text>
      <Text style={styles.statValue}>{formatPrice(value)}</Text>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: Colors.sheet },
  sheet: { flex: 1, backgroundColor: Colors.sheet },
  content: { padding: Spacing.xxl, paddingTop: Spacing.xxxl, gap: Spacing.xxl },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.lg },
  titleText: { flex: 1, gap: 2 },
  product: { ...Type.headline, color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  close: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  current: { fontSize: 34, lineHeight: 40, fontWeight: '600', letterSpacing: -0.6, color: Colors.text, ...tabularNumbers },
  stats: { flexDirection: 'row' },
  stat: { flex: 1, gap: 2 },
  statValue: { ...Type.headline, ...tabularNumbers, color: Colors.text },
  section: { gap: Spacing.md },
  sectionTitle: { ...Type.headline, color: Colors.text },
  storeRow: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  storeName: { ...Type.body, color: Colors.text, flex: 1 },
  storePrice: { ...Type.body, ...tabularNumbers, color: Colors.text },
});
