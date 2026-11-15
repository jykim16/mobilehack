import { MutationCtx } from "../_generated/server";
import { Id } from "../_generated/dataModel";
import { MERCHANTS } from "./merchants";

const H = 3_600_000;
const img = (id: string) => `https://images.unsplash.com/${id}?w=800&q=80&auto=format&fit=crop`;

export async function ensureMerchants(ctx: MutationCtx) {
  const existing = await ctx.db.query("merchants").first();
  if (existing) return;
  for (const m of MERCHANTS) await ctx.db.insert("merchants", m);
}

export async function seedDemoCart(ctx: MutationCtx, cartId: Id<"carts">, userId: Id<"users">) {
  const now = Date.now();
  const agentId = await ctx.db.insert("agents", {
    userId,
    cartId,
    name: "Claude Shopper",
    keyHash: `demo-${cartId}`,
    keyPrefix: "demo",
  });

  const items = [
    {
      title: "Nike Pegasus 41 Running Shoes",
      url: "https://www.nike.com/t/pegasus-41-mens-road-running-shoes",
      imageUrl: img("photo-1542291026-7eec264c27ff"),
      merchantDomain: "nike.com",
      price: 13999,
      addedAt: now - 76 * H,
      addedByKind: "user" as const,
      addedByName: "You",
      coolingOffHours: 24,
      votes: [
        { name: "Maya", value: 1 as const, comment: "These were a game changer for my half marathon." },
        { name: "Sam", value: 1 as const },
        { name: "Priya", value: 1 as const, comment: "Get the wide fit!" },
      ],
    },
    {
      title: "Sony WH-1000XM6 Noise Canceling Headphones",
      url: "https://www.bestbuy.com/site/sony-wh-1000xm6",
      imageUrl: img("photo-1505740420928-5e560c06d30e"),
      merchantDomain: "bestbuy.com",
      price: 39999,
      wasPrice: 44999,
      addedAt: now - 3 * H,
      addedByKind: "agent" as const,
      addedByName: "Claude Shopper",
      agentId,
      rationale:
        "You asked for headphones for your two upcoming long-haul flights. These lead every 2026 review for noise canceling, last 30 hours per charge, and are $50 off through Sunday.",
      alternatives: [
        { title: "Bose QuietComfort Ultra", price: 42900, reason: "Comfier, but $29 more and 6 fewer hours of battery" },
        { title: "AirPods Max", price: 54900, reason: "Great with your iPhone, but heavy and $149 more" },
      ],
      coolingOffHours: 24,
      votes: [{ name: "Sam", value: 1 as const, comment: "Have the XM5s, the upgrade is worth it." }],
    },
    {
      title: "Ninja Professional Plus Blender, 72 oz",
      url: "https://www.target.com/p/ninja-professional-plus-blender",
      imageUrl: img("photo-1585515320310-259814833e62"),
      merchantDomain: "target.com",
      price: 8999,
      wasPrice: 12999,
      addedAt: now - 30 * H,
      addedByKind: "agent" as const,
      addedByName: "Claude Shopper",
      agentId,
      rationale:
        "You've spent $152 on smoothies this month. This is the best-rated blender under $100, pays for itself in about three weeks, and Target's 90-day return window gives you time to decide.",
      alternatives: [{ title: "Vitamix E310", price: 34995, reason: "Lasts longer, but almost 4x the price" }],
      votes: [
        { name: "Priya", value: 1 as const },
        { name: "Maya", value: 1 as const, comment: "I use mine every morning." },
      ],
    },
    {
      title: "Ray-Ban Meta Wayfarer Smart Glasses",
      url: "https://www.amazon.com/dp/B0CHQ8Z1QJ",
      imageUrl: img("photo-1572635196237-14b3f281503f"),
      merchantDomain: "amazon.com",
      price: 29900,
      addedAt: now - 20 * H,
      addedByKind: "user" as const,
      addedByName: "You",
      votes: [
        { name: "Maya", value: 1 as const, comment: "So fun for concerts." },
        { name: "Sam", value: -1 as const, comment: "You'll stop wearing them in a month." },
      ],
    },
    {
      title: "Apple Watch Series 11, 46mm",
      url: "https://www.apple.com/shop/buy-watch/apple-watch",
      imageUrl: img("photo-1546868871-7041f2a55e12"),
      merchantDomain: "apple.com",
      price: 42900,
      addedAt: now - 0.3 * H,
      addedByKind: "agent" as const,
      addedByName: "Claude Shopper",
      agentId,
      rationale: "Newest model, matches your phone.",
      coolingOffHours: 72,
      votes: [],
    },
  ];

  for (const { votes, ...item } of items) {
    const itemId = await ctx.db.insert("items", { cartId, status: "considering", ...item });
    for (const v of votes) {
      await ctx.db.insert("votes", {
        itemId,
        cartId,
        voterKey: `demo-${v.name.toLowerCase()}`,
        voterName: v.name,
        value: v.value,
        comment: v.comment,
      });
    }
  }
}
