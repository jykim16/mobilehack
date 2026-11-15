import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { ProductImage } from '@/components/product-bits';
import { Shimmer, SkeletonBlock } from '@/components/skeleton';
import { Radius, Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';

const IMAGE = 88;

/**
 * Image, title, and variant with screen-specific details beside them; tapping the body opens the detail sheet.
 * While the item is still being looked up (gathering), a missing image or title shimmers in its place and
 * cross-fades to the real one when it arrives.
 */
export function ItemCard({
  title,
  subtitle,
  imageUrl,
  onOpen,
  gathering = false,
  children,
  footer,
}: {
  title: string | null;
  subtitle: string | null;
  imageUrl: string | null | undefined;
  onOpen?: () => void;
  gathering?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title ? `${title}, details` : 'Adding item'}
        disabled={!onOpen}
        onPress={onOpen}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
        {gathering && !imageUrl ? (
          <Shimmer>
            <SkeletonBlock width={IMAGE} height={IMAGE} radius={Radius.tile} />
          </Shimmer>
        ) : (
          <Animated.View key="image" entering={gathering ? undefined : FadeIn.duration(300)}>
            <ProductImage imageUrl={imageUrl} size={IMAGE} />
          </Animated.View>
        )}
        <View style={styles.details}>
          {title === null ? (
            <Shimmer style={styles.titleSkeleton}>
              <SkeletonBlock height={14} />
              <SkeletonBlock width="60%" height={14} />
            </Shimmer>
          ) : (
            <Animated.View entering={FadeIn.duration(300)}>
              <Text style={styles.title} numberOfLines={2}>
                {title}
              </Text>
              {subtitle && (
                <Text style={styles.variant} numberOfLines={1}>
                  {subtitle}
                </Text>
              )}
            </Animated.View>
          )}
          {children}
        </View>
      </Pressable>
      {footer}
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  container: { gap: Spacing.md },
  row: { flexDirection: 'row', gap: Spacing.md },
  rowPressed: { opacity: 0.7 },
  details: { flex: 1, gap: 2 },
  titleSkeleton: { gap: 7, paddingVertical: 3, marginBottom: 2 },
  title: { ...Type.headline, fontSize: 16, lineHeight: 21, color: Colors.text },
  variant: { ...Type.secondary, color: Colors.textSecondary },
});
