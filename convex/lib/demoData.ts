import type { SectionName } from "./validators";

export const HERO_ASIN = "B09XS7JWHH";
export const HERO_URL = `https://www.amazon.com/dp/${HERO_ASIN}`;
export const HERO_INITIAL_PRICE_CENTS = 27999;
export const HERO_DROPPED_PRICE_CENTS = 22999;
export const AIRFLY_URL = "https://www.bestbuy.com/site/twelve-south-airfly-pro/6411178.p";

const DAY = 24 * 3600_000;

type SeedOffer = {
  canonicalKey: string;
  variantLabel: string;
  retailer: string;
  retailerName: string;
  seller: string;
  url: string;
  priceCents: number;
  listPriceCents?: number;
  shippingCents: number;
  deliveryEstimate: string;
  returnSummary: string;
  rating?: { average: number; count: number };
  history: { daysAgo: number; priceCents: number }[];
};

export type SeedProduct = {
  demoKey: string;
  title: string;
  brand: string;
  category: string;
  imageUrl: string;
  description: string;
  variants: { label: string; sku: string }[];
  offers: SeedOffer[];
};

const AMAZON_RETURNS =
  "Free returns until Jan 31, 2027 (Amazon holiday window). Refund to original payment.";
const BESTBUY_RETURNS = "15-day returns (holiday purchases returnable until Jan 14, 2027).";

export const SEED_PRODUCTS: SeedProduct[] = [
  {
    demoKey: "hero-xm5",
    title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
    brand: "Sony",
    category: "wireless headphones",
    imageUrl: "https://m.media-amazon.com/images/I/51aXvjzcukL._AC_SL1500_.jpg",
    description: "Over-ear Bluetooth headphones with adaptive noise canceling and 30-hour battery.",
    variants: [
      { label: "Black", sku: HERO_ASIN },
      { label: "Silver", sku: "B09Y2MYL5C" },
    ],
    offers: [
      {
        canonicalKey: `amazon:${HERO_ASIN}`,
        variantLabel: "Black",
        retailer: "amazon",
        retailerName: "Amazon",
        seller: "Amazon.com",
        url: HERO_URL,
        priceCents: HERO_INITIAL_PRICE_CENTS,
        listPriceCents: 39999,
        shippingCents: 0,
        deliveryEstimate: "Arrives in 2-3 days with free Prime delivery",
        returnSummary: AMAZON_RETURNS,
        rating: { average: 4.4, count: 12873 },
        history: [
          { daysAgo: 90, priceCents: 39999 },
          { daysAgo: 70, priceCents: 34999 },
          { daysAgo: 45, priceCents: 32999 },
          { daysAgo: 25, priceCents: 29999 },
          { daysAgo: 6, priceCents: HERO_INITIAL_PRICE_CENTS },
        ],
      },
      {
        canonicalKey: "amazon:B09Y2MYL5C",
        variantLabel: "Silver",
        retailer: "amazon",
        retailerName: "Amazon",
        seller: "Amazon.com",
        url: "https://www.amazon.com/dp/B09Y2MYL5C",
        priceCents: 29999,
        listPriceCents: 39999,
        shippingCents: 0,
        deliveryEstimate: "Arrives in 3-4 days with free Prime delivery",
        returnSummary: AMAZON_RETURNS,
        rating: { average: 4.4, count: 12873 },
        history: [
          { daysAgo: 90, priceCents: 39999 },
          { daysAgo: 30, priceCents: 29999 },
        ],
      },
      {
        canonicalKey: "bestbuy:6505727",
        variantLabel: "Black",
        retailer: "bestbuy",
        retailerName: "Best Buy",
        seller: "Best Buy",
        url: "https://www.bestbuy.com/site/sony-wh-1000xm5/6505727.p",
        priceCents: 29999,
        listPriceCents: 39999,
        shippingCents: 0,
        deliveryEstimate: "Free shipping, arrives in 4-5 days",
        returnSummary: BESTBUY_RETURNS,
        rating: { average: 4.6, count: 2214 },
        history: [
          { daysAgo: 60, priceCents: 34999 },
          { daysAgo: 20, priceCents: 29999 },
        ],
      },
    ],
  },
  {
    demoKey: "airfly-pro",
    title: "Twelve South AirFly Pro Bluetooth Audio Transmitter",
    brand: "Twelve South",
    category: "travel audio accessories",
    imageUrl: "https://pisces.bbystatic.com/image2/BestBuy_US/images/products/6411/6411178_sd.jpg",
    description: "Plugs into any 3.5mm jack (like seatback entertainment) and streams to wireless headphones.",
    variants: [{ label: "White", sku: "6411178" }],
    offers: [
      {
        canonicalKey: "bestbuy:6411178",
        variantLabel: "White",
        retailer: "bestbuy",
        retailerName: "Best Buy",
        seller: "Best Buy",
        url: AIRFLY_URL,
        priceCents: 5499,
        shippingCents: 0,
        deliveryEstimate: "Free store pickup today, or ships in 2 days",
        returnSummary: BESTBUY_RETURNS,
        rating: { average: 4.5, count: 1630 },
        history: [
          { daysAgo: 60, priceCents: 5499 },
          { daysAgo: 10, priceCents: 5499 },
        ],
      },
    ],
  },
];

export function historyTimestamp(daysAgo: number, now: number) {
  return now - daysAgo * DAY;
}

export type SectionResult = {
  scope: "product" | "offer";
  summary: string;
  highlights: {
    label: string;
    detail: string;
    tone: "positive" | "negative" | "neutral" | "new_criterion";
  }[];
  sources: { title: string; url: string; publisher?: string }[];
  simulated: boolean;
};

/** Seeded, clearly labeled demo evidence for the seeded products. */
export const SEEDED_EVIDENCE: Record<string, Partial<Record<SectionName, SectionResult>>> = {
  "hero-xm5": {
    categoryGuidance: {
      scope: "product",
      simulated: true,
      summary:
        "For headphones you'll use on planes, two things matter that most shoppers don't ask about: whether they work wired with seatback entertainment, and whether they stay comfortable for a whole flight.",
      highlights: [
        {
          label: "Wired listening and audio quality",
          detail:
            "You didn't ask about this. Seatback entertainment is wired-only. The XM5 takes the included 3.5mm cable and keeps noise canceling on while wired, and audio quality over the cable is better than Bluetooth compression. Many rivals (e.g. AirPods Max) need an adapter and lose quality wired.",
          tone: "new_criterion",
        },
        {
          label: "Comfort on long flights",
          detail:
            "250 g with soft synthetic-leather pads. Reviewers report 6+ hours without hot spots, but the earcups don't fold, so the case is bulkier in a carry-on.",
          tone: "neutral",
        },
        {
          label: "Noise canceling for engine drone",
          detail: "Among the best at low-frequency cabin noise in lab tests.",
          tone: "positive",
        },
        {
          label: "Battery",
          detail: "About 30 hours with noise canceling on; 3 minutes of charging gives about 3 hours.",
          tone: "positive",
        },
      ],
      sources: [
        {
          title: "Sony WH-1000XM5 review",
          url: "https://www.rtings.com/headphones/reviews/sony/wh-1000xm5-wireless",
          publisher: "RTINGS.com",
        },
        {
          title: "WH-1000XM5 help guide: using the headphone cable",
          url: "https://helpguide.sony.net/mdr/wh1000xm5/v1/en/index.html",
          publisher: "Sony",
        },
      ],
    },
    returnTerms: {
      scope: "offer",
      simulated: true,
      summary: AMAZON_RETURNS,
      highlights: [
        { label: "Return window", detail: "Until Jan 31, 2027 for items bought Nov 1 - Dec 31.", tone: "positive" },
        { label: "Return shipping", detail: "Free at UPS drop-off or Whole Foods.", tone: "positive" },
        { label: "Condition", detail: "Opened headphones are returnable if all accessories are included.", tone: "neutral" },
      ],
      sources: [
        {
          title: "Amazon holiday return policy",
          url: "https://www.amazon.com/gp/help/customer/display.html?nodeId=GKM69DUUYKQWKWX7",
          publisher: "Amazon",
        },
      ],
    },
    retailerReviews: {
      scope: "offer",
      simulated: true,
      summary: "4.4 of 5 from 12,873 Amazon ratings. Comfort and noise canceling are praised; the non-folding design is the most common complaint.",
      highlights: [
        { label: "Comfort", detail: "\"Wore them for a full 11-hour flight to Tokyo without taking them off.\"", tone: "positive" },
        { label: "Wired mode", detail: "\"Plugged into the seatback with the cable and ANC still worked.\"", tone: "positive" },
        { label: "Portability", detail: "\"The case is big; it doesn't fold like the XM4.\"", tone: "negative" },
      ],
      sources: [
        {
          title: "Amazon customer reviews",
          url: `https://www.amazon.com/product-reviews/${HERO_ASIN}`,
          publisher: "Amazon",
        },
      ],
    },
    reddit: {
      scope: "product",
      simulated: true,
      summary: "r/headphones and r/travel threads lean positive for flights; heat after many hours comes up.",
      highlights: [
        { label: "r/travel", detail: "\"XM5 on a 14h flight: best purchase this year, but my ears got warm around hour 8.\"", tone: "positive" },
        { label: "r/headphones", detail: "\"If you mainly fly, XM5 over AirPods Max: lighter, and wired mode actually works.\"", tone: "positive" },
        { label: "r/headphones", detail: "\"Pads get warm on long wear; take short breaks.\"", tone: "negative" },
      ],
      sources: [
        { title: "Reddit search: WH-1000XM5 long flight", url: "https://www.reddit.com/search/?q=WH-1000XM5%20long%20flight", publisher: "Reddit" },
      ],
    },
  },
  "airfly-pro": {
    categoryGuidance: {
      scope: "product",
      simulated: true,
      summary: "Lets wireless-only headphones or earbuds use wired seatback entertainment.",
      highlights: [
        { label: "Battery", detail: "16+ hours, enough for most long-haul flights.", tone: "positive" },
        { label: "Latency", detail: "Small audio delay on video is noticeable to some users.", tone: "negative" },
      ],
      sources: [{ title: "Twelve South AirFly Pro", url: "https://www.twelvesouth.com/products/airfly-pro", publisher: "Twelve South" }],
    },
    retailerReviews: {
      scope: "offer",
      simulated: true,
      summary: "4.5 of 5 from 1,630 Best Buy reviews.",
      highlights: [
        { label: "Flights", detail: "\"Works with every airline seat I've tried.\"", tone: "positive" },
      ],
      sources: [{ title: "Best Buy reviews", url: AIRFLY_URL, publisher: "Best Buy" }],
    },
  },
};

export const RETAILER_RETURN_TERMS: Record<string, SectionResult> = {
  amazon: SEEDED_EVIDENCE["hero-xm5"].returnTerms!,
  bestbuy: {
    scope: "offer",
    simulated: true,
    summary: BESTBUY_RETURNS,
    highlights: [
      { label: "Return window", detail: "15 days standard; holiday purchases until Jan 14, 2027.", tone: "neutral" },
      { label: "Restocking", detail: "No restocking fee for most electronics.", tone: "positive" },
    ],
    sources: [{ title: "Best Buy return policy", url: "https://www.bestbuy.com/site/help-topics/return-exchange-policy/pcmcat260800050014.c", publisher: "Best Buy" }],
  },
};
