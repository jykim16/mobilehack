import { Image } from 'expo-image';
import { useColorScheme } from 'react-native';

export function WhopLogo() {
  const light = useColorScheme() === 'light';
  return <Image
    source={light ? require('../../assets/brands/whop/lockup-light.png') : require('../../assets/brands/whop/lockup-dark.png')}
    accessibilityLabel="Whop"
    contentFit="contain"
    style={{ width: 104, height: 24 }}
  />;
}
