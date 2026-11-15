import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';

import { Colors } from '@/constants/theme';
import { ShopProvider } from '@/data/shop-store';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: Colors.background, card: Colors.background, primary: Colors.accent },
};

export default function RootLayout() {
  return (
    <ThemeProvider value={theme}>
      <ShopProvider>
        <StatusBar style="light" />
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="cart" />
          <Stack.Screen
            name="price-history/[id]"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.82],
              sheetGrabberVisible: true,
              sheetCornerRadius: 24,
              contentStyle: { backgroundColor: Colors.surface },
            }}
          />
          <Stack.Screen
            name="checkout"
            options={{
              presentation: 'formSheet',
              sheetAllowedDetents: [0.75],
              sheetGrabberVisible: true,
              sheetCornerRadius: 24,
              contentStyle: { backgroundColor: Colors.surface },
            }}
          />
        </Stack>
      </ShopProvider>
    </ThemeProvider>
  );
}
