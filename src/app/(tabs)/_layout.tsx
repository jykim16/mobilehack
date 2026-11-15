import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';
import { useWindowDimensions, type ColorValue } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useColors } from '@/constants/theme';
import { useShop } from '@/data/shop-store';

/** Room for a 24pt icon and a label line, grown with the system font size so labels never clip, plus the nav-bar inset. */
const BAR_HEIGHT = 56;
const LABEL_LINE = 14;

type IconName = ComponentProps<typeof Ionicons>['name'];

function icon(active: IconName, inactive: IconName) {
  return function TabBarIcon({ focused, color, size }: { focused: boolean; color: ColorValue; size: number }) {
    return <Ionicons name={focused ? active : inactive} size={size} color={typeof color === 'string' ? color : undefined} />;
  };
}

export default function TabsLayout() {
  const Colors = useColors();
  const { cartCount } = useShop();
  const { fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const labelGrowth = Math.ceil(LABEL_LINE * Math.max(fontScale - 1, 0));
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: Colors.accent,
        tabBarInactiveTintColor: Colors.textSecondary,
        tabBarStyle: {
          height: BAR_HEIGHT + labelGrowth + insets.bottom,
          backgroundColor: Colors.background,
          borderTopColor: Colors.hairline,
        },
        tabBarItemStyle: { paddingVertical: 4 },
        tabBarLabelStyle: { fontSize: 11, lineHeight: LABEL_LINE },
        sceneStyle: { backgroundColor: Colors.background },
      }}>
      <Tabs.Screen
        name="index"
        options={{
          title: 'Cart',
          tabBarIcon: icon('cart', 'cart-outline'),
          tabBarBadge: cartCount > 0 ? cartCount : undefined,
          tabBarBadgeStyle: { backgroundColor: Colors.textSecondary, color: Colors.background },
        }}
      />
      <Tabs.Screen name="purchases" options={{ title: 'Purchases', tabBarIcon: icon('bag-check', 'bag-check-outline') }} />
      <Tabs.Screen name="account" options={{ title: 'Account', tabBarIcon: icon('person-circle', 'person-circle-outline') }} />
    </Tabs>
  );
}
