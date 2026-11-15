import { Text, View } from "react-native";
import { colors } from "@/lib/theme";
import type { CartItem } from "@/lib/types";

const ICONS: Record<string, string> = { deliberation: "⏳", social: "👥", returns: "↩︎", price: "🏷️", rationale: "✦" };

export function Breakdown({ signals }: { signals: CartItem["confidence"]["signals"] }) {
  return (
    <View style={{ gap: 14 }}>
      {signals.map((s) => {
        const pct = s.score / s.max;
        const fg = pct >= 0.75 ? colors.green : pct >= 0.45 ? colors.amber : colors.red;
        return (
          <View key={s.key} style={{ gap: 6 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
              <Text style={{ fontWeight: "700", color: colors.text, fontSize: 15 }}>
                {ICONS[s.key]}  {s.label}
              </Text>
              <Text style={{ fontWeight: "800", color: colors.text, fontVariant: ["tabular-nums"] }}>
                {s.score}
                <Text style={{ color: colors.faint }}>/{s.max}</Text>
              </Text>
            </View>
            <View style={{ height: 8, borderRadius: 4, backgroundColor: colors.bg, overflow: "hidden" }}>
              <View style={{ width: `${Math.max(4, pct * 100)}%`, height: "100%", backgroundColor: fg, borderRadius: 4 }} />
            </View>
            <Text style={{ color: colors.muted, fontSize: 13 }}>{s.detail}</Text>
          </View>
        );
      })}
    </View>
  );
}
