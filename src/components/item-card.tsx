import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { PillButton } from '@/components/pill-button';
import { ProductImage, RatingText } from '@/components/product-bits';
import { Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';
import type { Rating } from '@/data/types';

export function ItemCard({
  itemId,
  title,
  subtitle,
  imageUrl,
  rating,
  actionLabel,
  actionVariant,
  actionDisabled,
  onAction,
  onOpen,
  children,
}: {
  itemId: string;
  title: string;
  subtitle: string | null;
  imageUrl: string | null | undefined;
  rating: Rating | null;
  actionLabel: string;
  actionVariant: 'strong' | 'secondary';
  actionDisabled?: boolean;
  onAction: () => void;
  onOpen: () => void;
  children?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Pressable
        accessible={false}
        testID={`item-${itemId}`}
        onPress={onOpen}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        <ProductImage imageUrl={imageUrl} size={88} />
        <View style={styles.details}>
          <Text style={styles.title} numberOfLines={2}>
            {title}
          </Text>
          {subtitle && (
            <Text style={styles.variant} numberOfLines={1}>
              {subtitle}
            </Text>
          )}
          <RatingText
            rating={rating}
            onPress={() => router.push({ pathname: '/reviews/[id]', params: { id: itemId } })}
          />
          {children}
        </View>
      </Pressable>
      <View style={styles.footer}>
        <Pressable
          accessibilityRole="button"
          hitSlop={12}
          onPress={() => router.push({ pathname: '/price-history/[id]', params: { id: itemId } })}>
          {({ pressed }) => <Text style={[styles.priceHistory, pressed && styles.pressed]}>Price history</Text>}
        </Pressable>
        <PillButton label={actionLabel} variant={actionVariant} size="small" disabled={actionDisabled} onPress={onAction} />
      </View>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  container: { gap: Spacing.md },
  row: { flexDirection: 'row', gap: Spacing.md },
  rowPressed: { opacity: 0.7 },
  details: { flex: 1, gap: 2 },
  title: { ...Type.headline, fontSize: 16, lineHeight: 21, color: Colors.text },
  variant: { ...Type.secondary, color: Colors.textSecondary },
  footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  priceHistory: { ...Type.body, color: Colors.textSecondary },
  pressed: { color: Colors.text },
});
