import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';

import { useColors } from '@/constants/theme';
import { ShopProvider } from '@/data/shop-store';
import { SessionProvider, useSession } from '@/lib/session';

export default function RootLayout() {
  const Colors = useColors();
  const base = useColorScheme() === 'light' ? DefaultTheme : DarkTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, background: Colors.background, card: Colors.background, primary: Colors.accent },
  };
  return (
    <ThemeProvider value={theme}>
      <SessionProvider>
        <ShopProvider>
          <StatusBar style="auto" />
          <RootStack />
        </ShopProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}

function RootStack() {
  const Colors = useColors();
  const sheetOptions = {
    presentation: 'formSheet',
    sheetGrabberVisible: true,
    sheetCornerRadius: 24,
    contentStyle: { backgroundColor: Colors.sheet },
  } as const;
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
