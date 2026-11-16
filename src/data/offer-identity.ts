import { extractAsin } from '@/amazon';
import { formatPrice } from '@/lib/format';

import type { CartItem, Offer } from './types';

type IdentityFields = Pick<CartItem, 'url' | 'offer' | 'newOffer' | 'offerAvailability' | 'alternatives'>;

export interface ResolvedItemOffer {
  /** The saved listing Cart shows: an identical new-condition offer when there is one, else the saved offer. */
  offer: Offer | null;
  /** The listing Cart may buy, preview, or sync; null unless its identity matches the saved listing exactly. */
  checkoutOffer: Offer | null;
  /** A different listing (variant, store, or currency), shown only as an explicit alternative. */
  alternative: Pick<Offer, 'variantLabel' | 'retailerName' | 'priceCents' | 'currency'> | null;
  /** Amazon ASIN bound to checkoutOffer (or to the pasted Amazon link before enrichment); null when uncertain. */
  amazonAsin: string | null;
}

/**
 * One offer-identity rule shared by display, purchase, Amazon preview, and Amazon cart sync.
 * Backend #39 marks same-listing offers with offerAvailability.checkoutEligible; older payloads lack it,
 * so the client re-checks retailer, variant, currency, and (for Amazon) ASIN either way and never lets a
 * different listing stand in for the saved one.
 */
export function resolveItemOffer(item: IdentityFields): ResolvedItemOffer {
  const saved = item.offer;
  const availability = item.offerAvailability;
  if (!availability) {
    return { offer: saved, checkoutOffer: saved, alternative: null, amazonAsin: amazonAsinFor(item.url, saved) };
  }
  const candidate = item.newOffer ?? null;
  const verified = availability.checkoutEligible !== false && availability.identityVerified !== false;
  const checkoutOffer = verified && saved && candidate && sameListing(saved, candidate) ? candidate : null;
  const legacyAlternative = candidate && !checkoutOffer && candidate.id !== saved?.id ? candidate : null;
  const listedAlternative = (item.alternatives ?? []).find((a) => !(a.sameVariant && a.sameRetailer && a.sameCurrency)) ?? null;
  return {
    offer: checkoutOffer ?? saved,
    checkoutOffer,
    alternative: legacyAlternative ?? listedAlternative,
    amazonAsin: checkoutOffer ? amazonAsinFor(item.url, checkoutOffer) : null,
  };
}

function sameListing(saved: Offer, candidate: Offer): boolean {
  if (
    saved.retailer !== candidate.retailer ||
    saved.variantId !== candidate.variantId ||
    saved.currency.toUpperCase() !== candidate.currency.toUpperCase()
  ) {
    return false;
  }
  if (saved.retailer !== 'amazon') return true;
  const savedAsin = extractAsin(saved.url);
  return savedAsin !== null && savedAsin === extractAsin(candidate.url);
}

function amazonAsinFor(itemUrl: string, offer: Offer | null): string | null {
  const urlAsin = extractAsin(itemUrl);
  if (!offer) return urlAsin;
  if (offer.retailer !== 'amazon') return null;
  const offerAsin = extractAsin(offer.url);
  if (!offerAsin) return offer.url ? null : urlAsin;
  return urlAsin === null || urlAsin === offerAsin ? offerAsin : null;
}

/** Copy for an explicit alternative listing; it never stands in for the saved item's price. */
export function alternativeLine(offer: ResolvedItemOffer['alternative'] & object): string {
  const listing = [offer.variantLabel, offer.retailerName].filter(Boolean).join(' at ');
  return `A different listing${listing ? ` (${listing})` : ''} is ${formatPrice(offer.priceCents, offer.currency)}.`;
}

