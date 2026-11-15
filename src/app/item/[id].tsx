import { useMutation, useQuery } from "convex/react";
import * as Linking from "expo-linking";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Alert, Pressable, ScrollView, Share, Text, View } from "react-native";
import { api } from "../../../convex/_generated/api";
import { Id } from "../../../convex/_generated/dataModel";
import { Breakdown } from "@/components/Breakdown";
import { ConfidenceRing } from "@/components/ConfidenceRing";
import { Button, Card, Pill, SectionTitle, Thumb } from "@/components/ui";
import { VoteList } from "@/components/VoteList";
import { useNow, useSession } from "@/lib/session";
import { ago, colors, hoursLabel, money, scoreColor } from "@/lib/theme";

const COOLING = [
  { label: "Off", hours: undefined },
  { label: "24h", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
];

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { deviceId } = useSession();
  const now = useNow();
  const item = useQuery(api.items.get, { itemId: id as Id<"items">, now });
  const setCoolingOff = useMutation(api.items.setCoolingOff);
  const markPurchased = useMutation(api.items.markPurchased);
  const remove = useMutation(api.items.remove);

  if (item === undefined) return null;
  if (item === null)
    return (
      <View style={{ padding: 24 }}>
        <Text style={{ color: colors.muted }}>This item is gone.</Text>
      </View>
    );

  const c = item.confidence;
  const tone = scoreColor(c.score);
  const deal = item.wasPrice && item.price !== undefined && item.wasPrice > item.price;
  const shareItem = () =>
    Share.share({
      message: `Should I buy this? "${item.title}" (${money(item.price)}). Vote here: ${Linking.createURL(`/s/${item.shareCode}`)}  (code ${item.shareCode})`,
    });

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: 60 }}>
      <Stack.Screen options={{ title: item.merchant?.name ?? "" }} />
      <Card style={{ gap: 14 }}>
        <View style={{ flexDirection: "row", gap: 14 }}>
          <Thumb uri={item.imageUrl} size={96} />
          <View style={{ flex: 1, gap: 6 }}>
            <Text style={{ fontSize: 19, fontWeight: "800", color: colors.text }}>{item.title}</Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text style={{ fontSize: 22, fontWeight: "900", color: colors.text }}>{money(item.price)}</Text>
              {deal ? <Text style={{ color: colors.faint, textDecorationLine: "line-through" }}>{money(item.wasPrice)}</Text> : null}
            </View>
            {deal ? (
              <Pill text={`Deal · ${Math.round((1 - item.price! / item.wasPrice!) * 100)}% off`} fg={colors.green} bg={colors.greenSoft} icon="🏷️" />
            ) : null}
          </View>
        </View>
        <Text style={{ color: colors.muted, fontSize: 13 }}>
          Added {ago(item.addedAt, now)} by {item.addedByKind === "agent" ? `✦ ${item.addedByName}` : item.addedByName}
        </Text>
      </Card>

      <Card style={{ gap: 16 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
          <ConfidenceRing score={c.score} size={88} stroke={8} />
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontSize: 13, fontWeight: "800", color: colors.muted, letterSpacing: 0.6 }}>PURCHASE CONFIDENCE</Text>
            <Text style={{ fontSize: 22, fontWeight: "900", color: tone.fg }}>{tone.label}</Text>
            <Text style={{ color: colors.muted }}>
              {c.coolingOffRemainingHours > 0
                ? `Cooling off for ${hoursLabel(c.coolingOffRemainingHours)} more`
                : c.ready
                  ? "Ready to buy with confidence"
                  : "Give it more time or ask friends"}
            </Text>
          </View>
        </View>
        <Breakdown signals={c.signals} />
      </Card>

      {item.addedByKind === "agent" ? (
        <Card style={{ gap: 10, backgroundColor: colors.agentSoft }}>
          <Text style={{ fontWeight: "800", color: colors.agent }}>✦ Added by {item.addedByName} because…</Text>
          <Text style={{ fontSize: 16, lineHeight: 23, color: colors.text }}>{item.rationale}</Text>
          {item.alternatives?.length ? (
            <View style={{ gap: 8, marginTop: 4 }}>
              <Text style={{ fontWeight: "700", color: colors.agent, fontSize: 13 }}>ALTERNATIVES CONSIDERED</Text>
              {item.alternatives.map((a, i) => (
                <View key={i} style={{ backgroundColor: "#ffffffaa", borderRadius: 14, padding: 12, gap: 2 }}>
                  <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
                    <Text style={{ fontWeight: "700", color: colors.text, flex: 1 }}>{a.title}</Text>
                    {a.price !== undefined ? <Text style={{ fontWeight: "700", color: colors.text }}>{money(a.price)}</Text> : null}
                  </View>
                  {a.reason ? <Text style={{ color: colors.muted }}>{a.reason}</Text> : null}
                </View>
              ))}
            </View>
          ) : null}
        </Card>
      ) : item.rationale ? (
        <Card style={{ gap: 6 }}>
          <Text style={{ fontWeight: "800", color: colors.muted }}>Your note</Text>
          <Text style={{ fontSize: 16, color: colors.text }}>{item.rationale}</Text>
        </Card>
      ) : null}

      <SectionTitle>Cooling-off timer</SectionTitle>
      <View style={{ flexDirection: "row", gap: 8 }}>
        {COOLING.map((o) => {
          const active = item.coolingOffHours === o.hours;
          return (
            <Pressable
              key={o.label}
              onPress={() => setCoolingOff({ deviceId, itemId: item._id, hours: o.hours })}
              style={{
                flex: 1,
                paddingVertical: 12,
                borderRadius: 14,
                alignItems: "center",
                backgroundColor: active ? colors.accent : colors.card,
              }}
            >
              <Text style={{ fontWeight: "700", color: active ? "#fff" : colors.text }}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <SectionTitle>Friends say</SectionTitle>
      <Card style={{ gap: 14 }}>
        <VoteList votes={item.votes} />
        <Button title="Ask friends to vote" variant="secondary" onPress={shareItem} />
      </Card>

      <SectionTitle>Return policy</SectionTitle>
      <Card style={{ gap: 6 }}>
        {item.merchant ? (
          <>
            <Text style={{ fontWeight: "800", fontSize: 16, color: colors.text }}>
              {item.merchant.name} · {item.merchant.returnDays ? `${item.merchant.returnDays} days` : "Varies by seller"}
              {item.merchant.freeReturns ? " · Free returns" : ""}
            </Text>
            <Text style={{ color: colors.muted, lineHeight: 20 }}>{item.merchant.summary}</Text>
          </>
        ) : (
          <Text style={{ color: colors.muted }}>We don’t know this store’s policy yet. Check it before you buy.</Text>
        )}
      </Card>

      <View style={{ gap: 10, marginTop: 8 }}>
        {item.url ? <Button title={`Open at ${item.merchant?.name ?? "store"}`} onPress={() => Linking.openURL(item.url!)} /> : null}
        {item.status === "considering" ? (
          <Button title="Mark as purchased" variant="secondary" onPress={() => markPurchased({ deviceId, itemId: item._id })} />
        ) : null}
        <Button
          title="Remove from cart"
          variant="ghost"
          onPress={() =>
            Alert.alert("Remove item?", item.title, [
              { text: "Cancel", style: "cancel" },
              {
                text: "Remove",
                style: "destructive",
                onPress: async () => {
                  router.back();
                  await remove({ deviceId, itemId: item._id });
                },
              },
            ])
          }
        />
      </View>
    </ScrollView>
  );
}
