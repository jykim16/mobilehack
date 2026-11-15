import { Text, View } from "react-native";
import { colors } from "@/lib/theme";
import type { CartItem } from "@/lib/types";

export function VoteList({ votes }: { votes: CartItem["votes"] }) {
  if (!votes.length) return <Text style={{ color: colors.muted }}>No votes yet. Share this item to get a second opinion.</Text>;
  return (
    <View style={{ gap: 12 }}>
      {votes.map((v) => (
        <View key={v._id} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
          <View
            style={{
              width: 34,
              height: 34,
              borderRadius: 17,
              backgroundColor: v.value === 1 ? colors.greenSoft : colors.redSoft,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text>{v.value === 1 ? "👍" : "👎"}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontWeight: "700", color: colors.text }}>{v.voterName}</Text>
            {v.comment ? <Text style={{ color: colors.muted, marginTop: 2 }}>{v.comment}</Text> : null}
          </View>
        </View>
      ))}
    </View>
  );
}
