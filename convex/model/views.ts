import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { estimateTotals } from "../retail/pricing";
import { SECTION_NAMES } from "../lib/validators";

export function offerView(offer: Doc<"offers">, variantLabel: string | null) {
  return {
    id: offer._id,
    retailer: offer.retailer,
    retailerName: offer.retailerName,
    seller: offer.seller,
    url: offer.url,
    variantId: offer.variantId,
    variantLabel,
    priceCents: offer.priceCents,
    listPriceCents: offer.listPriceCents ?? null,
    shippingCents: offer.shippingCents,
    currency: offer.currency,
    deliveryEstimate: offer.deliveryEstimate,
    returnSummary: offer.returnSummary,
    rating: offer.rating ?? null,
    inStock: offer.inStock,
    purchasable: offer.inStock && offer.priceCents > 0,
    simulated: offer.simulated,
    updatedAt: offer.updatedAt,
  };
}

async function priceHistoryFor(ctx: QueryCtx, offer: Doc<"offers">) {
  const obs = await ctx.db
    .query("priceObservations")
    .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
    .order("asc")
    .take(200);
  const prices = obs.map((o) => o.priceCents);
  return {
    points: obs.map((o) => ({
      observedAt: o.observedAt,
      priceCents: o.priceCents,
      source: o.source,
      simulated: o.simulated,
    })),
    lowCents: prices.length ? Math.min(...prices) : offer.priceCents,
    highCents: prices.length ? Math.max(...prices) : offer.priceCents,
    currentCents: offer.priceCents,
  };
}

export async function cartItemView(
  ctx: QueryCtx,
  item: Doc<"cartItems">,
  detail: "summary" | "full",
) {
  const product = item.productId ? await ctx.db.get("products", item.productId) : null;
  const variant = item.variantId ? await ctx.db.get("variants", item.variantId) : null;
  const offer = item.offerId ? await ctx.db.get("offers", item.offerId) : null;

  const productOffers = product
    ? await ctx.db
        .query("offers")
        .withIndex("by_productId", (q) => q.eq("productId", product._id))
        .take(20)
    : [];
  const variantLabels = new Map<Id<"variants">, string>();
  for (const o of productOffers) {
    if (!variantLabels.has(o.variantId)) {
      const vdoc = await ctx.db.get("variants", o.variantId);
      variantLabels.set(o.variantId, vdoc?.label ?? "");
    }
  }
  const rated = productOffers.filter((o) => o.rating);
  const ratingCount = rated.reduce((n, o) => n + o.rating!.count, 0);
  const rating =
    ratingCount > 0
      ? {
          average:
            Math.round((rated.reduce((s, o) => s + o.rating!.average * o.rating!.count, 0) / ratingCount) * 10) / 10,
          count: ratingCount,
          retailers: rated.map((o) => ({ retailerName: o.retailerName, ...o.rating! })),
        }
      : null;

  const totals = offer ? estimateTotals(offer.priceCents, offer.shippingCents, item.quantity) : null;
  const target = item.decision?.targetCents;
  const compareTo =
    totals && target !== undefined
      ? item.decision?.targetAppliesTo === "item_price"
        ? offer!.priceCents
        : totals.totalCents
      : null;

  const evidenceDocs = await ctx.db
    .query("evidence")
    .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", item._id))
    .take(10);
  const sections = SECTION_NAMES.map((name) => {
    const e = evidenceDocs.find((d) => d.section === name);
    if (!e) return { section: name, status: "pending" as const, checkedAt: null, simulated: false };
    const base = {
      section: name,
      status: e.status,
      checkedAt: e.checkedAt ?? null,
      simulated: e.simulated,
      summary: e.summary ?? null,
    };
    return detail === "full"
      ? { ...base, scope: e.scope, highlights: e.highlights, sources: e.sources, error: e.error ?? null }
      : base;
  });

  const pending = await ctx.db
    .query("purchaseRequests")
    .withIndex("by_shopperId_and_status", (q) =>
      q.eq("shopperId", item.shopperId).eq("status", "pending_approval"),
    )
    .take(50);
  const pendingForItem = pending.find((r) => r.cartItemId === item._id);

  return {
    id: item._id,
    url: item.url,
    status: item.status,
    quantity: item.quantity,
    reason: item.reason ?? null,
    addedBy: item.addedBy,
    addedAt: item.addedAt,
    enrichmentStatus: item.enrichmentStatus,
    product: product
      ? {
          id: product._id,
          title: product.title,
          brand: product.brand ?? null,
          category: product.category,
          imageUrl: product.imageUrl ?? null,
          description: product.description ?? null,
        }
      : null,
    variant: variant ? { id: variant._id, label: variant.label } : null,
    offer: offer ? offerView(offer, variant?.label ?? null) : null,
    offers: productOffers.map((o) => offerView(o, variantLabels.get(o.variantId) ?? null)),
    rating,
    price: offer && totals
      ? {
          currentCents: offer.priceCents,
          listPriceCents: offer.listPriceCents ?? null,
          currency: offer.currency,
          ...totals,
          estimated: true,
        }
      : null,
    priceHistory: offer ? await priceHistoryFor(ctx, offer) : null,
    decision: item.decision
      ? {
          priorities: item.decision.priorities,
          targetCents: item.decision.targetCents ?? null,
          targetAppliesTo: item.decision.targetAppliesTo ?? null,
          targetMet: compareTo === null ? null : compareTo <= target!,
          updatedAt: item.decision.updatedAt,
        }
      : null,
    sections,
    pendingRequest: pendingForItem
      ? {
          requestId: pendingForItem._id,
          quoteVersion: pendingForItem.quoteVersion,
          totalCents: pendingForItem.quote?.totalCents ?? null,
          expiresAt: pendingForItem.expiresAt,
        }
      : null,
  };
}
