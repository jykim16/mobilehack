import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import type { ColorValue } from 'react-native';

import { useColors } from '@/constants/theme';
import { useShop } from '@/data/shop-store';

type IconName = ComponentProps<typeof Ionicons>['name'];

function icon(active: IconName, inactive: IconName) {
  return function TabBarIcon({ focused, color, size }: { focused: boolean; color: ColorValue; size: number }) {
    return <Ionicons name={focused ? active : inactive} size={size} color={typeof color === 'string' ? color : undefined} />;
  };
}

export default function TabsLayout() {
  const Colors = useColors();
  const { cartCount } = useShop();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textSecondary,
        tabBarStyle: { backgroundColor: Colors.background, borderTopColor: Colors.hairline },
        sceneStyle: { backgroundColor: Colors.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Cart',
          tabBarIcon: icon('cart', 'cart-outline'),
          tabBarBadge: cartCount > 0 ? cartCount : undefined,
          tabBarBadgeStyle: { backgroundColor: Colors.accent, color: Colors.onAccent },
        }}
      />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases', tabBarIcon: icon('bag-check', 'bag-check-outline') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
