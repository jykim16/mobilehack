import type { RawScrapedTrackingEvent, ShipmentEvent, ShipmentStatus } from './types';

const ASIN_PATTERNS: RegExp[] = [
  /\/dp\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/gp\/product\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/gp\/aw\/d\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/gp\/offer-listing\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /\/product\/([A-Z0-9]{10})(?:[/?&#]|$)/i,
  /[?&]asin=([A-Z0-9]{10})(?:[&#]|$)/i,
];

const BARE_ASIN_RE = /^[A-Z0-9]{10}$/i;

export function extractAsin(asinOrUrl?: string | null): string | null {
  if (!asinOrUrl) return null;
  const trimmed = asinOrUrl.trim();
  if (BARE_ASIN_RE.test(trimmed)) {
    return trimmed.toUpperCase();
  }
  for (const pattern of ASIN_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1].toUpperCase();
    }
  }
  return null;
}

export function isAmazonShortLink(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url.trim());
    const host = parsed.hostname.toLowerCase();
    return host === 'a.co' || host === 'amzn.to' || host.endsWith('.a.co');
  } catch {
    return false;
  }
}

export function canonicalAmazonProductUrl(asin: string): string {
  return `https://www.amazon.com/dp/${asin.toUpperCase()}`;
}

export function amazonOfferListingUrl(asin: string): string {
  return `https://www.amazon.com/gp/offer-listing/${asin.toUpperCase()}?ie=UTF8&condition=ALL`;
}

export const AMAZON_CART_URL = 'https://www.amazon.com/gp/cart/view.html';
export const AMAZON_ORDERS_URL = 'https://www.amazon.com/your-orders/orders';
export const AMAZON_SIGNOUT_URL =
  'https://www.amazon.com/gp/flex/sign-out.html?action=sign-out&path=%2Fgp%2Fyourstore%2Fhome';
export const AMAZON_SIGNIN_URL =
  'https://www.amazon.com/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.com%2Fgp%2Fcart%2Fview.html&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=anywhere_v2_us&openid.mode=checkid_setup&language=en_US&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0';

/**
 * Parse a price string like `"$329.00"`, `"Items (2): $199.00"`, `"199.48"`, or `"329"` into integer cents.
 * Prioritizes `$`-prefixed / `USD`-suffixed tokens so embedded counts like `(2)` or seller digits
 * (`onlineshopping22`) are never misread as dollar amounts.
 */
export function parsePriceToCents(raw?: string | number | null): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? Math.round(raw * 100) : null;
  }
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/,/g, '').trim();
  if (!cleaned) return null;

  const currencyMatch =
    cleaned.match(/\$\s*(\d+(?:\.\d{1,2})?)/) ??
    cleaned.match(/(\d+(?:\.\d{1,2})?)\s*USD\b/i);
  if (currencyMatch?.[1]) {
    const val = Number.parseFloat(currencyMatch[1]);
    return Number.isFinite(val) ? Math.round(val * 100) : null;
  }

  if (/^\d+(?:\.\d{1,2})?$/.test(cleaned)) {
    const val = Number.parseFloat(cleaned);
    return Number.isFinite(val) ? Math.round(val * 100) : null;
  }

  return null;
}

/**
 * Format integer cents (e.g. `32900`) into `"$329.00"`.
 */
export function formatCents(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null || !Number.isFinite(cents)) return '—';
  const dollars = cents / 100;
  if (currency === 'USD') {
    return `$${dollars.toFixed(2)}`;
  }
  return `${dollars.toFixed(2)} ${currency}`;
}

/**
 * Format a `lastSyncedAt` epoch millisecond value as `'Updated just now'`, `'Updated 2m ago'`, etc.
 */
export function formatRelativeSyncTime(
  lastSyncedAt: number | null,
  now: number = Date.now(),
): string {
  if (!lastSyncedAt) return 'Not synced yet';
  const elapsedSec = Math.max(0, Math.floor((now - lastSyncedAt) / 1000));
  if (elapsedSec < 45) return 'Updated just now';
  const elapsedMin = Math.floor(elapsedSec / 60);
  if (elapsedMin < 60) return `Updated ${elapsedMin}m ago`;
  const elapsedHr = Math.floor(elapsedMin / 60);
  if (elapsedHr < 24) return `Updated ${elapsedHr}h ago`;
  const elapsedDays = Math.floor(elapsedHr / 24);
  return `Updated ${elapsedDays}d ago`;
}

/**
 * Normalize Amazon order/package status copy strictly into the 4 contract statuses.
 */
export function normalizeShipmentStatus(headline?: string | null): ShipmentStatus {
  const text = (headline ?? '').toLowerCase();
  if (text.includes('delivered') || text.includes('handed directly') || text.includes('left near')) {
    return 'delivered';
  }
  if (text.includes('out for delivery') || text.includes('arriving today by')) {
    return 'out_for_delivery';
  }
  if (
    text.includes('shipped') ||
    text.includes('in transit') ||
    text.includes('on the way') ||
    text.includes('arriving ') ||
    text.includes('carrier facility') ||
    text.includes('picked up') ||
    text.includes('departed')
  ) {
    return 'shipped';
  }
  return 'ordered';
}

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const WEEKDAY_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function toIsoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Parse Amazon delivery copy like `"FREE delivery Tuesday, November 17"`,
 * `"Arriving tomorrow"`, or `"Delivered Nov 14"` into ISO `'YYYY-MM-DD'`.
 */
export function parseDeliveryEtaIso(
  deliveryText?: string | null,
  referenceMs: number = Date.now(),
): string | null {
  if (!deliveryText) return null;
  const text = deliveryText.trim();
  const base = new Date(referenceMs);

  if (/\btoday\b/i.test(text)) {
    return toIsoDate(base);
  }
  if (/\btomorrow\b/i.test(text)) {
    const next = new Date(base);
    next.setDate(next.getDate() + 1);
    return toIsoDate(next);
  }

  const monthMatch = text.match(
    /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
  );
  if (monthMatch) {
    const month = MONTH_INDEX[monthMatch[1].toLowerCase()];
    const day = Number.parseInt(monthMatch[2], 10);
    const explicitYear = monthMatch[3] ? Number.parseInt(monthMatch[3], 10) : null;
    if (month !== undefined && day >= 1 && day <= 31) {
      let year = explicitYear ?? base.getFullYear();
      const candidate = new Date(year, month, day);
      if (!explicitYear && candidate.getTime() < base.getTime() - 180 * 86_400_000) {
        year += 1;
      }
      return toIsoDate(new Date(year, month, day));
    }
  }

  const weekdayMatch = text.match(
    /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)\b/i,
  );
  if (weekdayMatch) {
    const targetDay = WEEKDAY_INDEX[weekdayMatch[1].toLowerCase()];
    if (targetDay !== undefined) {
      const diff = (targetDay - base.getDay() + 7) % 7 || 7;
      const next = new Date(base);
      next.setDate(next.getDate() + diff);
      return toIsoDate(next);
    }
  }

  return null;
}

/**
 * Keep only carrier hub city/state/country strings (e.g. `"San Jose, CA US"`).
 * Drops anything starting with digits or street keywords so residential street addresses never leak.
 */
export function sanitizeCarrierHubLocation(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  if (!trimmed || trimmed.length > 64) return null;
  if (/^\d/.test(trimmed) || /\b(apt|suite|st|ave|blvd|rd|dr|ln|ct|way)\b/i.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/**
 * Parse an Amazon tracking scan date + time (e.g. `"Saturday, November 14"` + `"2:15 PM"`)
 * into epoch milliseconds.
 */
export function parseTrackingEventTimestamp(
  dateText: string | null | undefined,
  timeText: string | null | undefined,
  referenceMs: number = Date.now(),
): number | null {
  if (!dateText && !timeText) return null;
  const ref = new Date(referenceMs);
  let year = ref.getFullYear();
  let month = ref.getMonth();
  let day = ref.getDate();

  if (dateText) {
    if (/\byesterday\b/i.test(dateText)) {
      const y = new Date(referenceMs - 86_400_000);
      year = y.getFullYear();
      month = y.getMonth();
      day = y.getDate();
    } else if (!/\btoday\b/i.test(dateText)) {
      const m = dateText.match(
        /\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,\s*(\d{4}))?/i,
      );
      if (m) {
        const parsedMonth = MONTH_INDEX[m[1].toLowerCase()];
        const parsedDay = Number.parseInt(m[2], 10);
        if (parsedMonth !== undefined && parsedDay >= 1 && parsedDay <= 31) {
          month = parsedMonth;
          day = parsedDay;
          if (m[3]) {
            year = Number.parseInt(m[3], 10);
          } else {
            const candidate = new Date(year, month, day);
            if (candidate.getTime() > referenceMs + 7 * 86_400_000) {
              year -= 1;
            }
          }
        }
      }
    }
  }

  let hours = 12;
  let minutes = 0;
  if (timeText) {
    const tm = timeText.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (tm) {
      hours = Number.parseInt(tm[1], 10);
      minutes = Number.parseInt(tm[2], 10);
      const meridiem = tm[3]?.toUpperCase();
      if (meridiem === 'PM' && hours < 12) hours += 12;
      if (meridiem === 'AM' && hours === 12) hours = 0;
    }
  }

  const built = new Date(year, month, day, hours, minutes, 0, 0).getTime();
  return Number.isFinite(built) ? built : null;
}

/**
 * Convert scraped `/progress-tracker/package/...` scan rows (which Amazon renders newest-first)
 * into chronological `ShipmentEvent[]` (**oldest first**), synthesizing baseline milestones
 * when carrier scan history has not yet populated.
 */
export function buildShipmentEvents(params: {
  rawEvents?: RawScrapedTrackingEvent[] | null;
  status: ShipmentStatus;
  headline: string;
  placedAt: number;
  updatedAt: number;
}): ShipmentEvent[] {
  const { rawEvents, status, headline, placedAt, updatedAt } = params;

  if (rawEvents && rawEvents.length > 0) {
    // Amazon tracking DOM lists newest scan at index 0, oldest at the bottom; reverse first so ties keep chronological order.
    const reversed = [...rawEvents].reverse();
    const mapped = reversed.map((ev, idx) => {
      const parsedTs = parseTrackingEventTimestamp(ev.dateText, ev.timeText, updatedAt);
      const fallbackTs = placedAt + idx * 60_000;
      return {
        status: normalizeShipmentStatus(ev.description),
        description: ev.description,
        location: sanitizeCarrierHubLocation(ev.location),
        occurredAt: parsedTs ?? fallbackTs,
        seq: idx,
      };
    });

    mapped.sort((a, b) => (a.occurredAt !== b.occurredAt ? a.occurredAt - b.occurredAt : a.seq - b.seq));
    return mapped.map(({ seq: _seq, ...rest }) => rest);
  }

  const baseline: ShipmentEvent[] = [
    {
      status: 'ordered',
      description: 'Order placed on Amazon',
      location: null,
      occurredAt: placedAt,
    },
  ];

  if (status !== 'ordered') {
    baseline.push({
      status,
      description: headline || 'Shipment updated by Amazon',
      location: null,
      occurredAt: Math.max(updatedAt, placedAt + 1_000),
    });
  }

  return baseline;
}
