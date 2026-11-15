import { router } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';

import { DetailSection } from '@/components/order-details';
import { reviewMeta, SourceLogo, summaryLine } from '@/components/review-bits';
import { Shimmer, SkeletonBlock } from '@/components/skeleton';
import { Radius, Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';
import { useReviews } from '@/data/shop-store';
import type { CartItem } from '@/data/types';

const PREVIEW_COUNT = 3;

/**
 * The first few aggregated reviews. While enrichment is still crawling and fewer than two have arrived,
 * shimmering placeholders hold their place, then cross-fade to the real rows.
 */
export function ReviewPreview({ item }: { item: CartItem }) {
  const styles = useThemedStyles(createStyles);
  const list = useReviews(item);
  const gathering = item.enrichmentStatus === 'resolving' || item.enrichmentStatus === 'enriching';
  const rows = (list?.reviews ?? []).slice(0, PREVIEW_COUNT);
  const loading = !list || (gathering && rows.length < 2);
  const openAll = () => router.push({ pathname: '/reviews/[id]', params: { id: item.id } });

  return (
    <DetailSection title="Reviews" action={!loading && rows.length > 0 ? { label: 'See all', onPress: openAll } : undefined}>
      {loading ? (
        <Animated.View key="skeleton" exiting={FadeOut.duration(200)} style={styles.rows}>
          <SkeletonRows />
        </Animated.View>
      ) : rows.length === 0 ? (
        <Text style={styles.muted}>No reviews yet.</Text>
      ) : (
        <Animated.View key="rows" entering={FadeIn.duration(300)} style={styles.rows}>
          {list && <Text style={styles.summary}>{summaryLine(list, item.rating)}</Text>}
          {rows.map((review) => {
            const meta = reviewMeta(review);
            return (
              <Pressable key={review.id} accessibilityRole="button" onPress={openAll} style={({ pressed }) => [styles.row, pressed && styles.pressed]}>
                <SourceLogo review={review} />
                <View style={styles.rowText}>
                  <Text style={styles.author} numberOfLines={1}>
                    {review.author ?? review.sourceName}
                    {meta.length > 0 && <Text style={styles.muted}>{`  ${meta}`}</Text>}
                  </Text>
                  <Text style={styles.snippet} numberOfLines={2}>
                    {review.text}
                  </Text>
                </View>
              </Pressable>
            );
          })}
        </Animated.View>
      )}
    </DetailSection>
  );
}

function SkeletonRows() {
  const styles = useThemedStyles(createStyles);
  return (
    <Shimmer style={styles.rows} label="Loading reviews">
      {Array.from({ length: PREVIEW_COUNT }, (_, index) => (
        <View key={index} style={styles.row}>
          <SkeletonBlock width={28} height={28} radius={Radius.pill} />
          <View style={styles.rowText}>
            <SkeletonBlock width="40%" style={styles.skeletonLine} />
            <SkeletonBlock style={styles.skeletonLine} />
            <SkeletonBlock width="75%" style={styles.skeletonLine} />
          </View>
        </View>
      ))}
    </Shimmer>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  rows: { gap: Spacing.lg },
  summary: { ...Type.secondary, color: Colors.textSecondary },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.md },
  pressed: { opacity: 0.6 },
  rowText: { flex: 1, gap: 2 },
  author: { ...Type.body, fontWeight: '600', color: Colors.text },
  muted: { ...Type.secondary, fontWeight: '400', color: Colors.textSecondary },
  snippet: { ...Type.body, color: Colors.text },
  skeletonLine: { marginVertical: 3 },
});
