import { router } from "expo-router";
import { Text, View } from "react-native";
import { Button, Card } from "@/components/ui";
import { colors } from "@/lib/theme";

// Placeholder for the Pro paywall. The Whop integration replaces startCheckout and flips users.isPro from its webhook.
const PERKS = ["Unlimited connected agents", "Price-drop alerts on cart items", "Group carts with friends"];

export default function PaywallScreen() {
  return (
    <View style={{ padding: 20, gap: 16 }}>
      <Text style={{ fontSize: 28, fontWeight: "900", color: colors.text }}>Shop with more confidence</Text>
      <Card style={{ gap: 12 }}>
        {PERKS.map((p) => (
          <Text key={p} style={{ fontSize: 16, color: colors.text }}>
            ✓  {p}
          </Text>
        ))}
      </Card>
      <Button title="Coming soon" disabled onPress={() => router.back()} />
    </View>
  );
}
