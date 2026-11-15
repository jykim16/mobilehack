import { useEffect, type ReactNode } from 'react';
import { StyleSheet, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withTiming } from 'react-native-reanimated';

import { useThemedStyles, type Palette } from '@/constants/theme';

/** Pulses its children between faint and visible while content loads. */
export function Shimmer({ children, style, label }: { children: ReactNode; style?: StyleProp<ViewStyle>; label?: string }) {
  const pulse = useSharedValue(0.35);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.9, { duration: 750 }), -1, true);
  }, [pulse]);
  const shimmer = useAnimatedStyle(() => ({ opacity: pulse.value }));
  return (
    <Animated.View style={[style, shimmer]} accessibilityLabel={label}>
      {children}
    </Animated.View>
  );
}

/** A placeholder shape in the control color; place it inside a Shimmer. */
export function SkeletonBlock({
  width = '100%',
  height = 12,
  radius = 6,
  style,
}: {
  width?: DimensionValue;
  height?: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const styles = useThemedStyles(createStyles);
  return <View style={[styles.block, { width, height, borderRadius: radius }, style]} />;
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  block: { backgroundColor: Colors.control },
});
