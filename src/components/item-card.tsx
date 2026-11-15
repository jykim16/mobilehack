import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ProductImage } from '@/components/product-bits';
import { Spacing, Type, useThemedStyles, type Palette } from '@/constants/theme';

/** Image, title, and variant with screen-specific details beside them; tapping the body opens the detail sheet. */
export function ItemCard({
  title,
  subtitle,
  imageUrl,
  onOpen,
  children,
  footer,
}: {
  title: string;
  subtitle: string | null;
  imageUrl: string | null | undefined;
  onOpen: () => void;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${title}, details`}
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
  title: { ...Type.headline, fontSize: 16, lineHeight: 21, color: Colors.text },
  variant: { ...Type.secondary, color: Colors.textSecondary },
});
