import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { Radius, Spacing, Type, useColors, useThemedStyles, type Palette } from '@/constants/theme';

type Variant = 'accent' | 'strong' | 'secondary';

const palette = (Colors: Palette): Record<Variant, { background: string; pressed: string; text: string }> => ({
  accent: { background: Colors.accent, pressed: Colors.accentPressed, text: Colors.onAccent },
  strong: { background: Colors.strong, pressed: Colors.strongPressed, text: Colors.onStrong },
  secondary: { background: Colors.control, pressed: Colors.controlPressed, text: Colors.text },
});

export function PillButton({
  label,
  onPress,
  variant = 'secondary',
  size = 'regular',
  icon,
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: 'regular' | 'small';
  icon?: ComponentProps<typeof Ionicons>['name'];
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(createStyles);
  const colors = palette(useColors())[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      disabled={disabled || loading}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'small' ? styles.small : styles.regular,
        { backgroundColor: pressed ? colors.pressed : colors.background, opacity: disabled ? 0.5 : 1 },
        style,
      ]}>
      {loading && <ActivityIndicator size="small" color={colors.text} />}
      {icon && !loading && <Ionicons name={icon} size={size === 'small' ? 16 : 20} color={colors.text} />}
      <Text style={[size === 'small' ? styles.smallLabel : styles.regularLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: Spacing.sm,
    borderRadius: Radius.pill,
  },
  regular: { height: 52, paddingHorizontal: Spacing.xxl },
  small: { height: 36, paddingHorizontal: Spacing.lg },
  regularLabel: { ...Type.headline },
  smallLabel: { ...Type.body, fontWeight: '600' },
});
