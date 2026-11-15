import type { ImageSource } from 'expo-image';

const bundled: Record<string, number> = {
  'sony-headphones': require('@/assets/products/sony-headphones.jpg'),
  'airfly-pro': require('@/assets/products/airfly-pro.jpg'),
  'soundcore-headphones': require('@/assets/products/soundcore-headphones.jpg'),
  'running-shoe': require('@/assets/products/running-shoe.jpg'),
  'espresso-machine': require('@/assets/products/espresso-machine.jpg'),
  'gps-watch': require('@/assets/products/gps-watch.jpg'),
  earbuds: require('@/assets/products/earbuds.jpg'),
};

export function productImageSource(imageUrl: string | null | undefined): ImageSource | number | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('asset:')) return bundled[imageUrl.slice('asset:'.length)] ?? null;
  return { uri: imageUrl };
}
