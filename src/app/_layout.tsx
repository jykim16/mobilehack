import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';
import { ShopProvider } from '@/data/shop-store';
import { SessionProvider, useSession } from '@/lib/session';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: Colors.background, card: Colors.background, primary: Colors.accent },
};

const sheetOptions = {
  presentation: 'formSheet',
  sheetGrabberVisible: true,
  sheetCornerRadius: 24,
  contentStyle: { backgroundColor: Colors.surface },
} as const;

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <SessionProvider>
        <ShopProvider>
          <StatusBar style="light" />
          <RootStack />
        </ShopProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

function RootStack() {
  const needsSignIn = useSession() === 'signed_out';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
      <Stack.Protected guard={!needsSignIn}>
        <Stack.Screen name="index" />
        <Stack.Screen name="cart" />
        <Stack.Screen name="connect-agent" />
        <Stack.Screen name="price-history/[id]" options={{ ...sheetOptions, sheetAllowedDetents: [0.82] }} />
        <Stack.Screen name="checkout" options={{ ...sheetOptions, sheetAllowedDetents: [0.75] }} />
      </Stack.Protected>
      <Stack.Protected guard={needsSignIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}
