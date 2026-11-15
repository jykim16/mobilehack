import { useMutation, useQuery } from "convex/react";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { FlatList, Pressable, Text, TextInput, View } from "react-native";
import { api } from "../../../convex/_generated/api";
import { ConfidenceRing } from "@/components/ConfidenceRing";
import { Button, Card, Field, Thumb } from "@/components/ui";
import { useNow, useSession } from "@/lib/session";
import { colors, money } from "@/lib/theme";
import type { CartItem } from "@/lib/types";

export default function FriendCartScreen() {
  const { code } = useLocalSearchParams<{ code: string }>();
  const { voterName, setVoterName } = useSession();
  const now = useNow();
  const data = useQuery(api.carts.byShareCode, { code: code ?? "", now });
  const [nameDraft, setNameDraft] = useState("");

  if (data === undefined) return null;
  if (data === null)
    return (
      <View style={{ padding: 24 }}>
        <Text style={{ color: colors.muted, fontSize: 16 }}>No cart found for code {code}.</Text>
      </View>
    );

  if (!voterName)
    return (
      <View style={{ padding: 20, gap: 16 }}>
        <Stack.Screen options={{ title: "Friend's cart" }} />
        <Text style={{ fontSize: 24, fontWeight: "900", color: colors.text }}>{data.ownerName} wants your opinion</Text>
        <Text style={{ color: colors.muted, fontSize: 16 }}>Vote on {data.summary.count} things they’re thinking about buying.</Text>
        <Field label="Your name" placeholder="So they know who voted" value={nameDraft} onChangeText={setNameDraft} autoFocus />
        <Button title="Start voting" disabled={!nameDraft.trim()} onPress={() => setVoterName(nameDraft.trim())} />
      </View>
    );

  return (
    <FlatList
      data={data.items.filter((i) => i.status === "considering")}
      keyExtractor={(i) => i._id}
      contentContainerStyle={{ padding: 20, gap: 12, paddingBottom: 60 }}
      ListHeaderComponent={
        <View style={{ marginBottom: 4, gap: 4 }}>
          <Stack.Screen options={{ title: "Friend's cart" }} />
          <Text style={{ fontSize: 24, fontWeight: "900", color: colors.text }}>Should they buy it?</Text>
          <Text style={{ color: colors.muted }}>Voting as {voterName}. Your votes update their confidence scores live.</Text>
        </View>
      }
      renderItem={({ item }) => <VoteCard item={item} />}
    />
  );
}

function VoteCard({ item }: { item: CartItem }) {
  const { voterId, voterName } = useSession();
  const cast = useMutation(api.votes.cast);
  const mine = item.votes.find((v) => v.voterKey === voterId);
  const [comment, setComment] = useState(mine?.comment ?? "");
  const vote = (value: 1 | -1) => cast({ itemId: item._id, voterKey: voterId, voterName, value, comment: comment || undefined });

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", gap: 12, alignItems: "center" }}>
        <Thumb uri={item.imageUrl} size={64} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text numberOfLines={2} style={{ fontWeight: "700", fontSize: 15, color: colors.text }}>{item.title}</Text>
          <Text style={{ color: colors.muted }}>
            {money(item.price)} · {item.merchant?.name ?? "Any store"}
          </Text>
        </View>
        <ConfidenceRing score={item.confidence.score} size={46} stroke={5} />
      </View>
      {item.addedByKind === "agent" && item.rationale ? (
        <Text style={{ color: colors.agent, fontSize: 13 }} numberOfLines={3}>
          ✦ {item.addedByName}: {item.rationale}
        </Text>
      ) : null}
      <TextInput
        placeholder="Add a comment (optional)"
        placeholderTextColor={colors.faint}
        value={comment}
        onChangeText={setComment}
        style={{ backgroundColor: colors.bg, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, color: colors.text }}
      />
      <View style={{ flexDirection: "row", gap: 10 }}>
        {([1, -1] as const).map((v) => {
          const active = mine?.value === v;
          const fg = v === 1 ? colors.green : colors.red;
          const bg = v === 1 ? colors.greenSoft : colors.redSoft;
          return (
            <Pressable
              key={v}
              onPress={() => vote(v)}
              accessibilityRole="button"
              accessibilityLabel={v === 1 ? "Buy it" : "Skip it"}
              style={{
                flex: 1,
                height: 48,
                borderRadius: 14,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: active ? fg : bg,
              }}
            >
              <Text style={{ fontSize: 16, fontWeight: "800", color: active ? "#fff" : fg }}>{v === 1 ? "👍  Buy it" : "👎  Skip it"}</Text>
            </Pressable>
          );
        })}
      </View>
      <Text style={{ color: colors.faint, fontSize: 12 }}>
        {item.votes.filter((v) => v.value === 1).length} 👍 · {item.votes.filter((v) => v.value === -1).length} 👎 so far
      </Text>
    </Card>
  );
}
