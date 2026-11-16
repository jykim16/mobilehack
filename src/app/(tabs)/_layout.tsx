import { NativeTabs } from 'expo-router/native-tabs';
import { useColorScheme } from 'react-native';

import { useColors } from '@/constants/theme';
import { useShop } from '@/data/shop-store';

/**
 * The system tab bar: Liquid Glass on iOS 26+, the Material bottom bar on Android. Each tab's first scroll
 * view gets the bar's inset automatically. The count badge is a neutral gray with white text in both themes.
 */
export default function TabsLayout() {
  const Colors = useColors();
  const dark = useColorScheme() === 'dark';
  const { cartCount } = useShop();
  return (
    <NativeTabs
      tintColor={Colors.accent}
      iconColor={{ default: Colors.textSecondary, selected: Colors.accent }}
      labelStyle={{ default: { color: Colors.textSecondary }, selected: { color: Colors.accent } }}
      backgroundColor={Colors.background}
      indicatorColor={Colors.control}
      badgeBackgroundColor={dark ? Colors.textTertiary : Colors.textSecondary}
      badgeTextColor={Colors.onAccent}
      labelVisibilityMode="labeled">
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf={{ default: 'cart', selected: 'cart.fill' }} md="shopping_cart" />
        <NativeTabs.Trigger.Label>Cart</NativeTabs.Trigger.Label>
        {cartCount > 0 && <NativeTabs.Trigger.Badge>{String(cartCount)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="purchases">
        <NativeTabs.Trigger.Icon sf={{ default: 'bag', selected: 'bag.fill' }} md="shopping_bag" />
        <NativeTabs.Trigger.Label>Purchases</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="account">
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} md="account_circle" />
        <NativeTabs.Trigger.Label>Account</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
