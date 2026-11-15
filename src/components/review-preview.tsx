import { router } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn, FadeOut, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { DetailSection } from '@/components/order-details';
import { reviewMeta, SourceLogo, summaryLine } from '@/components/review-bits';
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
  const pulse = useSharedValue(0.35);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 750 }), -1, true);
  }, [pulse]);
  const shimmer = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View style={[styles.rows, shimmer]} accessibilityLabel="Loading reviews">
      {Array.from({ length: PREVIEW_COUNT }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={styles.skeletonLogo} />
          <View style={styles.rowText}>
            <View style={[styles.skeletonLine, styles.skeletonShort]} />
            <View style={styles.skeletonLine} />
            <View style={[styles.skeletonLine, styles.skeletonMedium]} />
          </View>
        </View>
      ))}
    </Animated.View>
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
  skeletonLogo: { width: 28, height: 28, borderRadius: Radius.pill, backgroundColor: Colors.control },
  skeletonLine: { height: 12, borderRadius: 6, backgroundColor: Colors.control, marginVertical: 3 },
  skeletonShort: { width: '40%' },
  skeletonMedium: { width: '75%' },
});
