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

/**
 * Remote images known not to render. Best Buy's CDN answers this seeded AirFly Pro URL with its own
 * "Image Unavailable" PNG and a 200 status, so the client can't detect the failure; show the bundled shot.
 */
const replacements: Record<string, string> = {
  'https://pisces.bbystatic.com/image2/BestBuy_US/images/products/6411/6411178_sd.jpg': 'airfly-pro',
};

export function productImageSource(imageUrl: string | null | undefined): ImageSource | number | null {
  if (!imageUrl) return null;
  if (imageUrl.startsWith('asset:')) return bundled[imageUrl.slice('asset:'.length)] ?? null;
  const replacement = replacements[imageUrl];
  if (replacement) return bundled[replacement];
  return { uri: imageUrl };
}
