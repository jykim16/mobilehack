import { useShop } from './shop-store';
import type { QueryAlternative } from './types';

const SCHEME = /^https?:\/\//i;
const BARE_LINK = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

/** A pasted link, with https:// added when it was left off; null for anything that reads as a product name. */
export function productUrl(text: string): string | null {
  if (/\s/.test(text)) return null;
  if (SCHEME.test(text)) return text;
  return BARE_LINK.test(text) ? `https://${text}` : null;
}

/**
 * What the Cart input calls with the shopper's text: links go to cart:addItem, and anything else to
 * cart:addItemFromQuery, which resolves the text to a product first and may suggest alternatives.
 */
export function useAddFromInput(): (text: string) => Promise<{ itemId: string; alternatives: QueryAlternative[] }> {
  const { addItem, addItemFromQuery } = useShop();
  return async (text) => {
    const url = productUrl(text);
    if (url) return { itemId: await addItem(url), alternatives: [] };
    return addItemFromQuery(text);
  };
}
