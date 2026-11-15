import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';
import { ShopProvider } from '@/data/shop-store';
import { SessionProvider } from '@/lib/session';

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
          <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
            <Stack.Screen name="index" />
            <Stack.Screen name="cart" />
            <Stack.Screen name="price-history/[id]" options={{ ...sheetOptions, sheetAllowedDetents: [0.82] }} />
            <Stack.Screen name="checkout" options={{ ...sheetOptions, sheetAllowedDetents: [0.75] }} />
          </Stack>
        </ShopProvider>
      </SessionProvider>
    </ThemeProvider>
  );
}
