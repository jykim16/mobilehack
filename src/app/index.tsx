import { useQuery } from "convex/react";
import { router } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { api } from "../../convex/_generated/api";
import { ConfidenceRing } from "@/components/ConfidenceRing";
import { ItemCard } from "@/components/ItemCard";
import { Card } from "@/components/ui";
import { useNow, useSession } from "@/lib/session";
import { colors, money } from "@/lib/theme";

const FILTERS = ["All", "Ready", "Agents", "Bought"] as const;

export default function CartScreen() {
  const { deviceId } = useSession();
  const now = useNow();
  const data = useQuery(api.carts.mine, { deviceId, now });
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");

  if (!data) return <View style={{ flex: 1, backgroundColor: colors.bg }} />;
  const { summary } = data;
  const items = data.items.filter((i) =>
    filter === "Bought"
      ? i.status === "purchased"
      : i.status === "considering" && (filter === "All" || (filter === "Ready" ? i.confidence.ready : i.addedByKind === "agent")),
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={items}
        keyExtractor={(i) => i._id}
        contentContainerStyle={{ padding: 20, paddingTop: insets.top + 12, paddingBottom: 120, gap: 12 }}
        ListHeaderComponent={
          <View style={{ gap: 16, marginBottom: 4 }}>
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <View>
                <Text style={{ fontSize: 13, fontWeight: "700", color: colors.muted, letterSpacing: 0.5 }}>ONE CART · EVERY STORE</Text>
                <Text style={{ fontSize: 32, fontWeight: "900", color: colors.text, letterSpacing: -0.8 }}>{data.cart.name}</Text>
              </View>
              <View style={{ flexDirection: "row", gap: 8 }}>
                <HeaderButton icon="✦" label="Agents" onPress={() => router.push("/agents")} />
                <HeaderButton icon="↗" label="Share cart" onPress={() => router.push("/share")} />
              </View>
            </View>

            <Card style={{ flexDirection: "row", alignItems: "center", gap: 16, backgroundColor: colors.text }}>
              <View style={{ backgroundColor: "#fff", borderRadius: 999, padding: 4 }}>
                <ConfidenceRing score={summary.averageConfidence} size={76} stroke={7} label="avg" />
              </View>
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ color: "#fff", fontSize: 26, fontWeight: "900" }}>{money(summary.total)}</Text>
                <Text style={{ color: "#B9B9C6", fontSize: 14, fontWeight: "600" }}>
                  {summary.count} items · {summary.ready} ready to buy
                </Text>
                <Text style={{ color: "#B9B9C6", fontSize: 14, fontWeight: "600" }}>
                  {summary.fromAgents} from agents · {summary.votes} friend votes
                </Text>
              </View>
            </Card>

            <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
              {FILTERS.map((f) => (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  style={{
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    borderRadius: 999,
                    backgroundColor: filter === f ? colors.text : colors.card,
                  }}
                >
                  <Text style={{ fontWeight: "700", color: filter === f ? "#fff" : colors.text }}>{f}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        }
        renderItem={({ item }) => <ItemCard item={item} href={`/item/${item._id}`} />}
        ListEmptyComponent={
          <Card style={{ alignItems: "center", gap: 6, paddingVertical: 32 }}>
            <Text style={{ fontSize: 36 }}>🛒</Text>
            <Text style={{ fontSize: 16, fontWeight: "700", color: colors.text }}>Nothing here yet</Text>
            <Text style={{ color: colors.muted, textAlign: "center" }}>Paste a link from any store, or let your agent add things.</Text>
          </Card>
        }
      />
      <Pressable
          onPress={() => router.push("/add")}
          accessibilityRole="button"
          accessibilityLabel="Add item"
          style={({ pressed }) => ({
            position: "absolute",
            bottom: insets.bottom + 20,
            alignSelf: "center",
            backgroundColor: colors.accent,
            paddingHorizontal: 26,
            height: 56,
            borderRadius: 999,
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            opacity: pressed ? 0.85 : 1,
            shadowColor: colors.accent,
            shadowOpacity: 0.35,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 8 },
            elevation: 6,
          })}
        >
          <Text style={{ color: "#fff", fontSize: 22, fontWeight: "800", marginTop: -2 }}>+</Text>
          <Text style={{ color: "#fff", fontSize: 16, fontWeight: "800" }}>Add item</Text>
        </Pressable>
    </View>
  );
}

function HeaderButton({ icon, label, onPress }: { icon: string; label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: colors.card,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>{icon}</Text>
    </Pressable>
  );
}
