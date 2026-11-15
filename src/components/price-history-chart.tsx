import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import Svg, { Circle, Line, Path } from 'react-native-svg';
import { scheduleOnRN } from 'react-native-worklets';

import { Radius, Spacing, Type, tabularNumbers, useColors, useThemedStyles, type Palette } from '@/constants/theme';
import type { PricePoint } from '@/data/types';
import { formatPrice, formatShortDate } from '@/lib/format';

const HEIGHT = 150;
const PAD = 8;
const READOUT_WIDTH = 120;
const DOT = 12;

/**
 * Price line over time. Touch and hold to scrub: a vertical line and dot snap to the nearest observation
 * on the UI thread, a readout shows its price and date, and releasing clears it.
 */
export function PriceHistoryChart({
  points,
  sampled = false,
  caption = null,
}: {
  points: PricePoint[];
  /** A sparse sample: its lowest point is not a real low, so no low line is drawn. */
  sampled?: boolean;
  caption?: string | null;
}) {
  const Colors = useColors();
  const styles = useThemedStyles(createStyles);
  const [width, setWidth] = useState(0);
  const [index, setIndex] = useState<number | null>(null);

  const prices = points.map((p) => p.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const first = points[0].observedAt;
  const duration = points[points.length - 1].observedAt - first || 1;
  const xs = points.map((p) => PAD + ((p.observedAt - first) / duration) * (width - PAD * 2));
  const ys = prices.map((cents) => PAD + (1 - (cents - min) / (max - min || 1)) * (HEIGHT - PAD * 2));
  const path = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ');
  const last = points.length - 1;

  const active = useSharedValue(0);
  const lineX = useSharedValue(0);
  const dotY = useSharedValue(0);
  const shown = useSharedValue(-1);

  const select = (next: number | null) => {
    setIndex(next);
    if (next !== null && Platform.OS !== 'web') Haptics.selectionAsync();
  };

  const track = (x: number) => {
    'worklet';
    let nearest = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[nearest] - x)) nearest = i;
    lineX.value = xs[nearest];
    dotY.value = ys[nearest];
    active.value = 1;
    if (nearest !== shown.value) {
      shown.value = nearest;
      scheduleOnRN(select, nearest);
    }
  };

  const scrub = Gesture.Pan()
    .activateAfterLongPress(150)
    .onStart((event) => track(event.x))
    .onUpdate((event) => track(event.x))
    .onFinalize(() => {
      if (shown.value === -1) return;
      active.value = 0;
      shown.value = -1;
      scheduleOnRN(select, null);
    });

  const lineStyle = useAnimatedStyle(() => ({ opacity: active.value, transform: [{ translateX: lineX.value - 0.5 }] }));
  const dotStyle = useAnimatedStyle(() => ({
    opacity: active.value,
    transform: [{ translateX: lineX.value - DOT / 2 }, { translateY: dotY.value - DOT / 2 }],
  }));
  const readoutStyle = useAnimatedStyle(() => ({
    opacity: active.value,
    transform: [{ translateX: Math.min(Math.max(lineX.value - READOUT_WIDTH / 2, 0), Math.max(width - READOUT_WIDTH, 0)) }],
  }));

  const selected = index !== null ? points[index] : null;

  return (
    <View>
      <View style={styles.readoutRow}>
        {!selected && <Text style={styles.hint}>Touch and hold the chart to see past prices</Text>}
        <Animated.View style={[styles.readout, readoutStyle]} pointerEvents="none">
          {selected && (
            <>
              <Text style={styles.readoutPrice}>{formatPrice(selected.priceCents)}</Text>
              <Text style={styles.readoutDate}>
                {sampled ? 'Sampled ' : ''}
                {formatShortDate(selected.observedAt)}
              </Text>
            </>
          )}
        </Animated.View>
      </View>
      <GestureDetector gesture={scrub}>
        <View style={styles.chart} onLayout={(e) => setWidth(e.nativeEvent.layout.width)} accessibilityLabel="Price history chart">
          {width > 0 && (
            <>
              <Svg width={width} height={HEIGHT}>
                {!sampled && <Line x1={PAD} x2={width - PAD} y1={ys[prices.indexOf(min)]} y2={ys[prices.indexOf(min)]} stroke={Colors.textTertiary} strokeDasharray="3 5" strokeWidth={1} />}
                <Path d={path} stroke={Colors.accent} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
                <Circle cx={xs[last]} cy={ys[last]} r={5} fill={Colors.accent} />
              </Svg>
              <Animated.View pointerEvents="none" style={[styles.scrubLine, lineStyle]} />
              <Animated.View pointerEvents="none" style={[styles.scrubDot, dotStyle]} />
            </>
          )}
        </View>
      </GestureDetector>
      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{formatShortDate(first)}</Text>
        <Text style={styles.axisLabel}>Today</Text>
      </View>
      {caption && <Text style={styles.caption}>{caption}</Text>}
    </View>
  );
}

const createStyles = (Colors: Palette) => StyleSheet.create({
  readoutRow: { height: 40, justifyContent: 'center' },
  hint: { ...Type.secondary, color: Colors.textTertiary },
  readout: {
    position: 'absolute',
    left: 0,
    width: READOUT_WIDTH,
    alignItems: 'center',
    paddingVertical: 2,
    borderRadius: Radius.tile,
    backgroundColor: Colors.control,
  },
  readoutPrice: { ...Type.body, ...tabularNumbers, fontWeight: '600', color: Colors.text },
  readoutDate: { ...Type.secondary, color: Colors.textSecondary, fontSize: 12, lineHeight: 15 },
  chart: { height: HEIGHT },
  scrubLine: { position: 'absolute', top: 0, left: 0, width: 1, height: HEIGHT, backgroundColor: Colors.textSecondary },
  scrubDot: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: DOT,
    height: DOT,
    borderRadius: DOT / 2,
    backgroundColor: Colors.accent,
    borderWidth: 2,
    borderColor: Colors.surface,
  },
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingHorizontal: PAD },
  axisLabel: { ...Type.secondary, color: Colors.textTertiary },
  caption: { ...Type.secondary, color: Colors.textTertiary, marginTop: Spacing.xs, paddingHorizontal: PAD },
});
