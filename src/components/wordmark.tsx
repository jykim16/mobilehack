import { useEffect } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { CartLogo } from '@/components/cart-logo';
import { Spacing, useThemedStyles, type Palette } from '@/constants/theme';

/** The Cart mark beside the lowercase "cart" wordmark. `hop` gives the mark one small wheelie on mount. */
export function Wordmark({ hop = false, style }: { hop?: boolean; style?: StyleProp<ViewStyle> }) {
  const styles = useThemedStyles(createStyles);
  const reduceMotion = useReducedMotion();
  const lift = useSharedValue(0);

  useEffect(() => {
    if (!hop || reduceMotion) return;
    lift.set(
      withDelay(
        300,
        withSequence(
          withTiming(1, { duration: 180, easing: Easing.out(Easing.quad) }),
          withSpring(0, { damping: 9, stiffness: 260 }),
        ),
      ),
    );
  }, [hop, reduceMotion, lift]);

  const hopStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -4 * lift.get() }, { rotate: `${-10 * lift.get()}deg` }],
  }));

  return (
    <View style={[styles.row, style]} accessible accessibilityRole="header" accessibilityLabel="Cart">
      <Animated.View style={[styles.mark, hopStyle]}>
        <CartLogo size={26} />
      </Animated.View>
      <Text style={styles.text}>cart</Text>
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: Spacing.sm },
  mark: { transformOrigin: '40% 80%' },
  text: { fontSize: 24, lineHeight: 30, fontWeight: '700', letterSpacing: -1, color: Colors.accent },
});
