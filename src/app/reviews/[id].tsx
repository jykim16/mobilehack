import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { reviewMeta, SourceLogo, summaryLine } from '@/components/review-bits';
import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import { useItem, useReviews } from '@/data/shop-store';
import type { Review, ReviewList, ReviewSource } from '@/data/types';
import { formatPostedDate } from '@/lib/format';

type Filter = 'all' | ReviewSource;

export default function ReviewsSheet() {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const item = useItem(id);
  const list = useReviews(item);
  const [filter, setFilter] = useState<Filter>('all');

  if (!item || !list) {
    return (
      <View style={[styles.sheet, styles.loading]}>
        <ActivityIndicator color={Colors.textSecondary} />
      </View>
    );
  }

  const gathering = item.enrichmentStatus === 'resolving' || item.enrichmentStatus === 'enriching';
  const visible = filter === 'all' ? list.reviews : list.reviews.filter((review) => review.source === filter);
  const filters = sourceFilters(list);

  return (
    <View style={styles.sheet}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <View style={styles.titleText}>
            <Text style={styles.title}>Reviews</Text>
            <Text style={styles.muted} numberOfLines={1}>
              {item.product?.title}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={8} onPress={() => router.back()} style={styles.close}>
            <Ionicons name="close" size={18} color={Colors.text} />
          </Pressable>
        </View>
        <Text style={styles.summary}>{summaryLine(list, item.rating)}</Text>
        {filters.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroller}
            contentContainerStyle={styles.chips}>
            {[{ value: 'all' as Filter, label: 'All' }, ...filters].map((chip) => {
              const selected = chip.value === filter;
              return (
                <Pressable
                  key={chip.value}
                  accessibilityRole="tab"
                  accessibilityState={{ selected }}
                  onPress={() => setFilter(chip.value)}
                  style={[styles.chip, selected && styles.chipSelected]}>
                  <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{chip.label}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      <FlatList
        data={visible}
        keyExtractor={(review) => review.id}
        renderItem={({ item: review }) => <ReviewRow review={review} />}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + Spacing.xxl }]}
        ListEmptyComponent={
          <Text style={styles.muted}>{gathering ? 'Gathering reviews…' : 'No reviews yet.'}</Text>
        }
        ListFooterComponent={
          visible.length > 0 && gathering ? <Text style={styles.footnote}>Gathering more reviews…</Text> : undefined
        }
      />
    </View>
  );
}

function sourceFilters({ reviews, bySource }: ReviewList) {
  return bySource
    .filter((entry) => reviews.some((review) => review.source === entry.source))
    .map((entry) => {
      const names = new Set(reviews.filter((review) => review.source === entry.source).map((review) => review.sourceName));
      return { value: entry.source as Filter, label: names.size === 1 ? [...names][0] : 'Other stores' };
    });
}

function ReviewRow({ review }: { review: Review }) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const [expanded, setExpanded] = useState(false);
  const meta = reviewMeta(review);

  return (
    <View style={styles.row}>
      <View style={styles.rowHeader}>
        <SourceLogo review={review} />
        <View style={styles.rowTitle}>
          <View style={styles.authorRow}>
            <Text style={styles.author} numberOfLines={1}>
              {review.author ?? review.sourceName}
            </Text>
            {review.postedAt !== null && <Text style={styles.date}>{formatPostedDate(review.postedAt)}</Text>}
          </View>
          {(meta || review.simulated) && (
            <Text style={styles.muted}>
              {meta}
              {review.simulated && <Text style={styles.demo}>{meta ? ' · Demo' : 'Demo'}</Text>}
            </Text>
          )}
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityHint={expanded ? 'Collapses the review' : 'Shows the full review'}
        onPress={() => setExpanded((value) => !value)}>
        <Text style={styles.text} numberOfLines={expanded ? undefined : 3}>
          {review.text}
        </Text>
      </Pressable>
      <Pressable accessibilityRole="link" hitSlop={8} onPress={() => WebBrowser.openBrowserAsync(review.url)} style={styles.link}>
        {({ pressed }) => (
          <>
            <Text style={[styles.linkText, pressed && styles.pressed]}>View on {review.sourceName}</Text>
            <Ionicons name="arrow-up-outline" size={13} color={pressed ? Colors.text : Colors.textSecondary} style={styles.linkIcon} />
          </>
        )}
      </Pressable>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  sheet: { flex: 1, backgroundColor: Colors.sheet },
  loading: { alignItems: 'center', justifyContent: 'center' },
  header: { paddingHorizontal: Spacing.xxl, paddingTop: Spacing.xxl, gap: Spacing.md },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: Spacing.lg },
  titleText: { flex: 1, gap: 2 },
  title: { ...Type.title, color: Colors.text },
  close: {
    width: 32,
    height: 32,
    borderRadius: Radius.pill,
    backgroundColor: Colors.control,
    alignItems: 'center',
    justifyContent: 'center',
  },
  summary: { ...Type.body, ...tabularNumbers, color: Colors.text },
  chipScroller: { marginHorizontal: -Spacing.xxl, flexGrow: 0 },
  chips: { gap: Spacing.sm, paddingHorizontal: Spacing.xxl, paddingBottom: Spacing.md },
  chip: { height: 32, paddingHorizontal: Spacing.md, borderRadius: Radius.pill, justifyContent: 'center' },
  chipSelected: { backgroundColor: Colors.control },
  chipLabel: { ...Type.secondary, fontSize: 14, fontWeight: '600', color: Colors.textSecondary },
  chipLabelSelected: { color: Colors.text },
  list: { paddingHorizontal: Spacing.xxl, paddingTop: Spacing.sm },
  separator: { height: StyleSheet.hairlineWidth, backgroundColor: Colors.hairline, marginVertical: Spacing.lg },
  row: { gap: Spacing.sm },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.md },
  rowTitle: { flex: 1 },
  authorRow: { flexDirection: 'row', justifyContent: 'space-between', gap: Spacing.md },
  author: { ...Type.body, fontWeight: '600', color: Colors.text, flexShrink: 1 },
  date: { ...Type.secondary, color: Colors.textSecondary },
  text: { ...Type.body, color: Colors.text },
  link: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 2 },
  linkText: { ...Type.secondary, color: Colors.textSecondary },
  linkIcon: { transform: [{ rotate: '45deg' }] },
  pressed: { color: Colors.text },
  muted: { ...Type.secondary, color: Colors.textSecondary },
  demo: { color: Colors.textTertiary },
  footnote: { ...Type.secondary, color: Colors.textTertiary, marginTop: Spacing.xxl, textAlign: 'center' },
});
