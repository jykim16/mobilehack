import { Text, View } from "react-native";
import Svg, { Circle } from "react-native-svg";
import { colors, scoreColor } from "@/lib/theme";

export function ConfidenceRing({ score, size = 56, stroke = 6, label }: { score: number; size?: number; stroke?: number; label?: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const { fg } = scoreColor(score);
  return (
    <View style={{ width: size, height: size, alignItems: "center", justifyContent: "center" }}>
      <Svg width={size} height={size} style={{ position: "absolute", transform: [{ rotate: "-90deg" }] }}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={colors.border} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={fg}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${(c * score) / 100} ${c}`}
        />
      </Svg>
      <Text style={{ fontSize: size * 0.32, fontWeight: "800", color: colors.text, fontVariant: ["tabular-nums"] }}>{score}</Text>
      {label ? <Text style={{ fontSize: size * 0.11, color: colors.muted, fontWeight: "600", marginTop: -2 }}>{label}</Text> : null}
    </View>
  );
}
