import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { Colors, Radius, Spacing, Type } from '@/constants/theme';

type Variant = 'accent' | 'strong' | 'secondary';

const palette: Record<Variant, { background: string; pressed: string; text: string }> = {
  accent: { background: Colors.accent, pressed: Colors.accentPressed, text: Colors.onAccent },
  strong: { background: Colors.strong, pressed: '#D8D8DC', text: Colors.onStrong },
  secondary: { background: Colors.control, pressed: Colors.controlPressed, text: Colors.text },
};

export function PillButton({
  label,
  onPress,
  variant = 'secondary',
  size = 'regular',
  icon,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: Variant;
  size?: 'regular' | 'small';
  icon?: ComponentProps<typeof Ionicons>['name'];
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = palette[variant];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        size === 'small' ? styles.small : styles.regular,
        { backgroundColor: pressed ? colors.pressed : colors.background, opacity: disabled ? 0.5 : 1 },
        style,
      ]}>
      {icon && <Ionicons name={icon} size={size === 'small' ? 16 : 20} color={colors.text} />}
      <Text style={[size === 'small' ? styles.smallLabel : styles.regularLabel, { color: colors.text }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
