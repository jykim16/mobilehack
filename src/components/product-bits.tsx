import { Image } from 'expo-image';
import { StyleSheet, Text, View } from 'react-native';

import { Colors, Radius, Type, tabularNumbers } from '@/constants/theme';
import type { Rating } from '@/data/types';
import { formatCount, formatPrice } from '@/lib/format';
import { productImageSource } from '@/lib/product-image';
import { retailerBrand } from '@/lib/retailer-brand';

export function ProductImage({ imageUrl, size }: { imageUrl: string | null | undefined; size: number }) {
  const source = productImageSource(imageUrl);
  return (
    <View style={[styles.tile, { width: size, height: size }]}>
      {source !== null && <Image source={source} style={styles.image} contentFit="contain" transition={150} />}
    </View>
  );
}

export function RetailerLogo({ retailer, retailerName, size = 40 }: { retailer: string; retailerName: string; size?: number }) {
  const brand = retailerBrand(retailer, retailerName);
  const fontSize = size * (brand.mark.length > 2 ? 0.3 : brand.mark.length > 1 ? 0.36 : 0.46);
  return (
    <View style={[styles.logo, { width: size, height: size, backgroundColor: brand.background }]}>
      <Text style={[styles.logoText, { color: brand.foreground, fontSize }]}>{brand.mark}</Text>
    </View>
  );
}

export function RatingText({ rating }: { rating: Rating | null }) {
  if (!rating) return null;
  return (
    <Text
      style={styles.rating}
      accessibilityLabel={`Rated ${rating.average} out of 5 from ${rating.count} reviews across ${rating.retailers.length} stores`}>
      <Text style={styles.ratingValue}>{rating.average.toFixed(1)} ★</Text> ({formatCount(rating.count)} reviews)
    </Text>
  );
}

export function PriceText({ priceCents, listPriceCents }: { priceCents: number; listPriceCents: number | null }) {
  return (
    <View>
      <Text style={styles.price}>{formatPrice(priceCents)}</Text>
      {listPriceCents !== null && listPriceCents > priceCents && (
        <Text style={styles.originalPrice}>{formatPrice(listPriceCents)}</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: Colors.imageTile,
    borderRadius: Radius.tile,
    overflow: 'hidden',
    padding: 6,
  },
  image: { flex: 1 },
  logo: {
    borderRadius: Radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoText: { fontWeight: '800', letterSpacing: -0.3 },
  rating: { ...Type.secondary, color: Colors.textSecondary },
  ratingValue: { color: Colors.text },
  price: { ...Type.headline, ...tabularNumbers, color: Colors.text },
  originalPrice: {
    ...Type.secondary,
    ...tabularNumbers,
    color: Colors.textSecondary,
    textDecorationLine: 'line-through',
  },
});
