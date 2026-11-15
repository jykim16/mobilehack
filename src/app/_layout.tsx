import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import type { ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { AmazonBrowserProvider } from '@/amazon';
import { useColors } from '@/constants/theme';
import { ShopProvider } from '@/data/shop-store';
import { SessionProvider, useSession, useShopperId } from '@/lib/session';

export default function RootLayout() {
  const Colors = useColors();
  const base = useColorScheme() === 'light' ? DefaultTheme : DarkTheme;
  const theme = {
    ...base,
    colors: { ...base.colors, background: Colors.background, card: Colors.background, primary: Colors.accent },
  };
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider value={theme}>
        <SessionProvider>
          <ShopperAmazonProvider>
            <ShopProvider>
              <StatusBar style="auto" />
              <RootStack />
            </ShopProvider>
          </ShopperAmazonProvider>
        </SessionProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}

function ShopperAmazonProvider({ children }: { children: ReactNode }) {
  return <AmazonBrowserProvider shopperId={useShopperId()}>{children}</AmazonBrowserProvider>;
}

function RootStack() {
  const Colors = useColors();
  const needsSignIn = useSession() === 'signed_out';
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: Colors.background } }}>
      <Stack.Protected guard={!needsSignIn}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="connect-agent" />
        <Stack.Screen name="item/[id]" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="purchase/[id]" options={{ presentation: 'fullScreenModal' }} />
        <Stack.Screen name="reviews/[id]" options={{ presentation: 'modal', contentStyle: { backgroundColor: Colors.sheet } }} />
      </Stack.Protected>
      <Stack.Protected guard={needsSignIn}>
        <Stack.Screen name="sign-in" />
      </Stack.Protected>
    </Stack>
  );
}
