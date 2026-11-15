import { useQuery } from "convex/react";
import * as Clipboard from "expo-clipboard";
import * as Linking from "expo-linking";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Share, Text, View } from "react-native";
import { api } from "../../convex/_generated/api";
import { Button, Card, Field } from "@/components/ui";
import { useNow, useSession } from "@/lib/session";
import { colors } from "@/lib/theme";

export default function ShareScreen() {
  const { deviceId } = useSession();
  const now = useNow();
  const data = useQuery(api.carts.mine, { deviceId, now });
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  if (!data) return null;
  const shareCode = data.cart.shareCode;
  const link = Linking.createURL(`/s/${shareCode}`);

  return (
    <ScrollView contentContainerStyle={{ padding: 20, gap: 16 }} keyboardShouldPersistTaps="handled">
      <Card style={{ alignItems: "center", gap: 10, paddingVertical: 28 }}>
        <Text style={{ fontSize: 13, fontWeight: "800", color: colors.muted, letterSpacing: 0.8 }}>YOUR CART CODE</Text>
        <Text style={{ fontSize: 44, fontWeight: "900", letterSpacing: 8, color: colors.text, fontVariant: ["tabular-nums"] }}>{shareCode}</Text>
        <Text style={{ color: colors.muted, textAlign: "center", paddingHorizontal: 12 }}>
          Friends open the link or type this code to vote 👍 or 👎 on what’s in your cart. Votes show up live.
        </Text>
      </Card>
      <Button
        title="Share link"
        onPress={() => Share.share({ message: `Help me decide what to buy! Vote on my cart: ${link}  (or enter code ${shareCode} in MobileCart)` })}
      />
      <Button
        title={copied ? "Copied ✓" : "Copy code"}
        variant="secondary"
        onPress={async () => {
          await Clipboard.setStringAsync(shareCode);
          setCopied(true);
        }}
      />

      <View style={{ height: 1, backgroundColor: colors.border, marginVertical: 8 }} />
      <Text style={{ fontSize: 18, fontWeight: "800", color: colors.text }}>Vote on a friend’s cart</Text>
      <Field label="Their code" placeholder="ABC123" value={code} onChangeText={(t) => setCode(t.toUpperCase())} autoCapitalize="characters" maxLength={6} />
      <Button title="Open cart" disabled={code.trim().length < 6} onPress={() => router.push({ pathname: "/s/[code]", params: { code: code.trim() } })} />
    </ScrollView>
  );
}
