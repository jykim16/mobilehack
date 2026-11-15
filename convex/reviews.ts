import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireShopper } from "./lib/auth";
import { loadOwnedItem } from "./model/cart";

const reviewSource = v.union(
  v.literal("reddit"),
  v.literal("x"),
  v.literal("amazon"),
  v.literal("bestbuy"),
  v.literal("youtube"),
  v.literal("other"),
);
type ReviewSource = "reddit" | "x" | "amazon" | "bestbuy" | "youtube" | "other";

type SocialSeed = {
  source: ReviewSource;
  sourceName: string;
  author: string;
  text: string;
  rating: number | null;
  url: string;
  score: number | null;
  daysAgo: number;
};

/** Seeded, clearly labeled social evidence for the demo's hero product. */
const SEEDED_SOCIAL: Record<string, SocialSeed[]> = {
  "hero-xm5": [
    {
      source: "x",
      sourceName: "X",
      author: "@seatbacksam",
      text: "Flew SFO to NRT with the XM5. Noise canceling killed the engine drone and the 3.5mm cable worked in the seatback. Battery still at 40% on landing.",
      rating: null,
      url: "https://x.com/seatbacksam/status/1857000200000000001",
      score: 1842,
      daysAgo: 12,
    },
    {
      source: "x",
      sourceName: "X",
      author: "@dealwatch",
      text: "XM5 dropped to $229 on Amazon, the lowest I have logged since launch. The holiday return window makes it a safe try.",
      rating: null,
      url: "https://x.com/dealwatch/status/1857000200000000002",
      score: 963,
      daysAgo: 3,
    },
    {
      source: "youtube",
      sourceName: "YouTube",
      author: "FlightGear Lab",
      text: "Long-haul headphone test: eleven hours in the XM5. Comfort holds to about hour eight, then the pads get warm, and the non-folding case is bulky in a carry-on.",
      rating: 4.5,
      url: "https://www.youtube.com/watch?v=xm5-longhaul-test",
      score: 128000,
      daysAgo: 30,
    },
    {
      source: "youtube",
      sourceName: "YouTube",
      author: "The Cable Test",
      text: "Wired versus Bluetooth on a plane: wired mode keeps noise canceling on and sounds noticeably cleaner, which is the one spec most buyers never check.",
      rating: 4.8,
      url: "https://www.youtube.com/watch?v=xm5-wired-vs-bluetooth",
      score: 54000,
      daysAgo: 65,
    },
  ],
};

type Review = {
  id: string;
  source: ReviewSource;
  sourceName: string;
  author: string;
  text: string;
  rating: number | null;
  postedAt: number;
  url: string;
  score: number | null;
  simulated: boolean;
};

const DAY = 24 * 3600_000;

function retailerSource(retailer: string): ReviewSource {
  return retailer === "amazon" || retailer === "bestbuy" ? retailer : "other";
}

/** Live Reddit highlights carry "(1.2 points, 45 comments)"; seeded ones don't. */
function scoreFromDetail(detail: string): number | null {
  const m = detail.match(/\((\d[\d,]*)\s*points?,\s*(\d[\d,]*)\s*comments?\)/);
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

export const list = query({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const shopperId = await requireShopper(ctx);
    const item = await loadOwnedItem(ctx, shopperId, cartItemId);
    const offer = item.offerId ? await ctx.db.get("offers", item.offerId) : null;
    const product = item.productId ? await ctx.db.get("products", item.productId) : null;

    const evidence = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId))
      .take(10);
    const reviewedAt = Date.now();
    const collected: Review[] = [];

    const reddit = evidence.find((e) => e.section === "reddit");
    if (reddit && reddit.status === "ready") {
      reddit.highlights.forEach((highlight, i) => {
        const source = reddit.sources[i] ?? reddit.sources[0];
        if (!source) return;
        const base = reviewedAt - (i + 1) * 2 * DAY;
        collected.push({
          id: `reddit-${i}`,
          source: "reddit",
          sourceName: "Reddit",
          author: highlight.label,
          text: highlight.detail,
          rating: null,
          postedAt: base,
          url: `${source.url}#review-${i}`,
          score: scoreFromDetail(highlight.detail),
          simulated: reddit.simulated,
        });
      });
    }

    const retailerReviews = evidence.find((e) => e.section === "retailerReviews");
    if (retailerReviews && retailerReviews.status === "ready" && offer) {
      retailerReviews.highlights.forEach((highlight, i) => {
        const source = retailerReviews.sources[0];
        if (!source) return;
        collected.push({
          id: `retailer-${i}`,
          source: retailerSource(offer.retailer),
          sourceName: offer.retailerName,
          author: highlight.label,
          text: highlight.detail,
          rating: null,
          postedAt: reviewedAt - (i + 1) * 5 * DAY,
          url: `${source.url}#review-${i}`,
          score: null,
          simulated: retailerReviews.simulated,
        });
      });
    }

    for (const seed of (product?.demoKey && SEEDED_SOCIAL[product.demoKey]) || []) {
      collected.push({
        id: `${seed.source}-${seed.url}`,
        source: seed.source,
        sourceName: seed.sourceName,
        author: seed.author,
        text: seed.text,
        rating: seed.rating,
        postedAt: reviewedAt - seed.daysAgo * DAY,
        url: seed.url,
        score: seed.score,
        simulated: true,
      });
    }

    const seen = new Set<string>();
    const reviews = collected
      .sort((a, b) => b.postedAt - a.postedAt)
      .filter((r) => (seen.has(r.url) ? false : (seen.add(r.url), true)));

    const tally = new Map<ReviewSource, { source: ReviewSource; count: number; rated: number[] }>();
    for (const r of reviews) {
      const entry = tally.get(r.source) ?? { source: r.source, count: 0, rated: [] };
      entry.count += 1;
      if (r.rating !== null) entry.rated.push(r.rating);
      tally.set(r.source, entry);
    }
    const bySource = [...tally.values()].map((e) => ({
      source: e.source,
      count: e.count,
      average:
        e.rated.length > 0
          ? Math.round((e.rated.reduce((s, n) => s + n, 0) / e.rated.length) * 10) / 10
          : null,
    }));

    return { reviews, bySource };
  },
  returns: v.object({
    reviews: v.array(
      v.object({
        id: v.string(),
        source: reviewSource,
        sourceName: v.string(),
        author: v.string(),
        text: v.string(),
        rating: v.union(v.number(), v.null()),
        postedAt: v.number(),
        url: v.string(),
        score: v.union(v.number(), v.null()),
        simulated: v.boolean(),
      }),
    ),
    bySource: v.array(
      v.object({
        source: reviewSource,
        count: v.number(),
        average: v.union(v.number(), v.null()),
      }),
    ),
  }),
});
