import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, View } from 'react-native';

import { RetailerLogo } from '@/components/product-bits';
import { BrandColors, Radius } from '@/constants/theme';
import type { Rating, Review, ReviewList, ReviewSource } from '@/data/types';
import { formatCount } from '@/lib/format';

/**
 * The headline rating comes from item.rating (retailer ratings summed). bySource counts only the rows in this
 * response, so the review count reads as how many are shown, never as a total.
 */
export function summaryLine({ reviews, bySource }: ReviewList, rating: Rating | null) {
  const rated = bySource.filter((entry) => entry.average !== null);
  const ratedCount = rated.reduce((sum, entry) => sum + entry.count, 0);
  const average = rating?.average ?? (ratedCount ? rated.reduce((sum, entry) => sum + (entry.average ?? 0) * entry.count, 0) / ratedCount : null);
  return [
    average !== null ? `${average.toFixed(1)} ★` : null,
    rating ? `${formatCount(rating.count)} ratings` : null,
    `${reviews.length} ${reviews.length === 1 ? 'review' : 'reviews'} shown`,
  ]
    .filter(Boolean)
    .join(' · ');
}

const socialLogos: Partial<Record<ReviewSource, { icon: keyof typeof Ionicons.glyphMap; background: string; foreground: string }>> = {
  reddit: { icon: 'logo-reddit', background: BrandColors.reddit, foreground: BrandColors.onBrand },
  x: { icon: 'logo-x', background: BrandColors.onBrand, foreground: BrandColors.x },
  youtube: { icon: 'logo-youtube', background: BrandColors.youtube, foreground: BrandColors.onBrand },
};

const scoreUnits: Partial<Record<ReviewSource, string>> = { reddit: 'upvotes', x: 'likes', youtube: 'likes' };

export function SourceLogo({ review }: { review: Review }) {
  const social = socialLogos[review.source];
  if (!social) {
    const retailer = review.source === 'other' ? review.sourceName.toLowerCase().replace(/\W/g, '') : review.source;
    return <RetailerLogo retailer={retailer} retailerName={review.sourceName} size={28} />;
  }
  return (
    <View style={[styles.logo, { backgroundColor: social.background }]}>
      <Ionicons name={social.icon} size={16} color={social.foreground} />
    </View>
  );
}

/** Source (when an author is shown), then the star rating or the score, e.g. "Reddit · 214 upvotes". */
export function reviewMeta(review: Review) {
  return [
    review.author ? review.sourceName : null,
    review.rating !== null
      ? `${review.rating} ★`
      : review.score !== null
        ? `${formatCount(review.score)} ${scoreUnits[review.source] ?? 'helpful'}`
        : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

const styles = StyleSheet.create({
  logo: { width: 28, height: 28, borderRadius: Radius.pill, alignItems: 'center', justifyContent: 'center' },
});
