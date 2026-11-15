import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { Colors, Spacing, Type } from '@/constants/theme';
import type { PricePoint } from '@/data/types';
import { formatShortDate } from '@/lib/format';

const HEIGHT = 150;
const PAD = 8;

export function PriceChart({ points }: { points: PricePoint[] }) {
  const [width, setWidth] = useState(0);
  const prices = points.map((p) => p.priceCents);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (width - PAD * 2);
  const y = (cents: number) => PAD + (1 - (cents - min) / span) * (HEIGHT - PAD * 2);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.priceCents).toFixed(1)}`).join(' ');
  const lowIndex = prices.indexOf(min);
  const last = points.length - 1;

  return (
    <View>
      <View style={{ height: HEIGHT }} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {width > 0 && (
          <Svg width={width} height={HEIGHT}>
            <Line x1={PAD} x2={width - PAD} y1={y(min)} y2={y(min)} stroke={Colors.textTertiary} strokeDasharray="3 5" strokeWidth={1} />
            <Path d={path} stroke={Colors.accent} strokeWidth={2.5} fill="none" strokeLinejoin="round" strokeLinecap="round" />
            {lowIndex !== last && <Circle cx={x(lowIndex)} cy={y(min)} r={3.5} fill={Colors.textSecondary} />}
            <Circle cx={x(last)} cy={y(prices[last])} r={6} fill={Colors.accent} stroke={Colors.surface} strokeWidth={2} />
          </Svg>
        )}
      </View>
      <View style={styles.axis}>
        <Text style={styles.axisLabel}>{formatShortDate(points[0].observedAt)}</Text>
        <Text style={styles.axisLabel}>Today</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  axis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: Spacing.sm, paddingHorizontal: PAD },
  axisLabel: { ...Type.secondary, color: Colors.textTertiary },
});
