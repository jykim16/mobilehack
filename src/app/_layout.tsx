import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { AppProviders } from "@/lib/session";
import { colors } from "@/lib/theme";

export default function RootLayout() {
  return (
    <AppProviders>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: colors.bg },
          headerTitleStyle: { fontWeight: "800" },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
          headerBackButtonDisplayMode: "minimal",
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="item/[id]" options={{ title: "" }} />
        <Stack.Screen name="add" options={{ title: "Add to cart", presentation: "modal" }} />
        <Stack.Screen name="share" options={{ title: "Ask friends", presentation: "modal" }} />
        <Stack.Screen name="agents" options={{ title: "Your agents" }} />
        <Stack.Screen name="paywall" options={{ title: "MobileCart Pro", presentation: "modal" }} />
        <Stack.Screen name="s/[code]" options={{ title: "Vote" }} />
      </Stack>
    </AppProviders>
  );
}
