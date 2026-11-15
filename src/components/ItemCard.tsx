import { router } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { ConfidenceRing } from "./ConfidenceRing";
import { Card, Pill, Thumb } from "./ui";
import { colors, hoursLabel, money, scoreColor } from "@/lib/theme";
import type { CartItem } from "@/lib/types";

export function ItemCard({ item, href }: { item: CartItem; href: string }) {
  const c = item.confidence;
  const ups = item.votes.filter((v) => v.value === 1).length;
  const downs = item.votes.length - ups;
  const deal = item.wasPrice && item.price !== undefined && item.wasPrice > item.price;
  return (
      <Pressable onPress={() => router.push(href as any)} accessibilityRole="button" accessibilityLabel={item.title} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] })}>
        <Card style={{ flexDirection: "row", gap: 14, alignItems: "center", opacity: item.status === "purchased" ? 0.55 : 1 }}>
          <Thumb uri={item.imageUrl} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text numberOfLines={2} style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>
              {item.title}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ fontSize: 16, fontWeight: "800", color: colors.text }}>{money(item.price)}</Text>
              {deal ? <Text style={{ fontSize: 13, color: colors.faint, textDecorationLine: "line-through" }}>{money(item.wasPrice)}</Text> : null}
              <Text style={{ fontSize: 13, color: colors.muted }}>· {item.merchant?.name ?? item.merchantDomain ?? "Any store"}</Text>
            </View>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {item.status === "purchased" ? (
                <Pill text="Purchased" fg={colors.muted} bg={colors.bg} icon="✓" />
              ) : c.coolingOffRemainingHours > 0 ? (
                <Pill text={`${hoursLabel(c.coolingOffRemainingHours)} cooling off`} fg={colors.accent} bg={colors.accentSoft} icon="⏳" />
              ) : c.ready ? (
                <Pill text="Ready to buy" fg={colors.green} bg={colors.greenSoft} icon="✓" />
              ) : null}
              {item.addedByKind === "agent" ? <Pill text={item.addedByName} fg={colors.agent} bg={colors.agentSoft} icon="✦" /> : null}
              {item.votes.length ? <Pill text={`${ups} · ${downs}`} fg={colors.text} bg={colors.bg} icon="👍" /> : null}
            </View>
          </View>
          <View style={{ alignItems: "center", gap: 4 }}>
            <ConfidenceRing score={c.score} size={54} />
            <Text style={{ fontSize: 10, fontWeight: "700", color: scoreColor(c.score).fg }}>{scoreColor(c.score).label}</Text>
          </View>
        </Card>
      </Pressable>
  );
}
