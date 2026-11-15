import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { estimateTotals } from "../retail/pricing";
import { isPurchasableCondition, offerConditionClass } from "../lib/conditions";
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
    condition: offer.condition ?? null,
    conditionClass: offerConditionClass(offer),
    provenance: offer.provenance ?? null,
    inStock: offer.inStock,
    purchasable: offer.inStock && offer.priceCents > 0 && isPurchasableCondition(offer),
    simulated: offer.simulated,
    updatedAt: offer.updatedAt,
  };
}

async function priceHistoryFor(
  ctx: QueryCtx,
  offer: Doc<"offers">,
  history: Doc<"evidence"> | null,
) {
  const obs = await ctx.db
    .query("priceObservations")
    .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offer._id))
    .order("asc")
    .take(200);
  const observationPoints = obs.map((o) => ({
    observedAt: o.observedAt,
    priceCents: o.priceCents,
    source: o.source,
    simulated: o.simulated,
  }));
  const observed = obs.map((o) => o.priceCents);
  const range = (prices: number[]) => ({
    lowCents: prices.length ? Math.min(...prices) : offer.priceCents,
    highCents: prices.length ? Math.max(...prices) : offer.priceCents,
  });

  const h = history?.history ?? null;
  const base = {
    observationCount: obs.length,
    currentCents: offer.priceCents,
    trackingSinceAdded: obs.length <= 1,
  };

  if (h && (h.mode === "live" || h.mode === "sampled") && h.points.length > 0) {
    const prices = h.points.map((p) => p.priceCents);
    return {
      ...base,
      mode: h.mode,
      seriesLabel: h.seriesLabel,
      sourceUrl: h.sourceUrl,
      sampled: h.sampled,
      note: h.note,
      points: h.points.map((p) => ({
        observedAt: p.at,
        priceCents: p.priceCents,
        source: h.mode === "sampled" ? "Sampled from Keepa" : (h.seriesLabel ?? "Keepa"),
        simulated: false,
      })),
      // A sparse sample is not a low or a high.
      ...(h.sampled ? { lowCents: null, highCents: null } : range(prices)),
    };
  }
  if (h) {
    return {
      ...base,
      mode: h.mode,
      seriesLabel: h.seriesLabel,
      sourceUrl: h.sourceUrl,
      sampled: h.sampled,
      note: h.note,
      points: observationPoints,
      ...range(observed),
    };
  }
  return {
    ...base,
    mode: "observations" as const,
    seriesLabel: null,
    sourceUrl: null,
    sampled: false,
    note: null,
    points: observationPoints,
    ...range(observed),
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
  // One rating per retailer: sibling variants of the same listing share a review
  // set, so summing them would double-count.
  const perRetailer = new Map<string, { retailerName: string; average: number; count: number }>();
  for (const o of productOffers) {
    if (!o.rating) continue;
    const seen = perRetailer.get(o.retailer);
    if (!seen || o.rating.count > seen.count) {
      perRetailer.set(o.retailer, { retailerName: o.retailerName, ...o.rating });
    }
  }
  const retailers = [...perRetailer.values()];
  const ratingCount = retailers.reduce((n, r) => n + r.count, 0);
  const rating =
    ratingCount > 0
      ? {
          average:
            Math.round((retailers.reduce((s, r) => s + r.average * r.count, 0) / ratingCount) * 10) / 10,
          count: ratingCount,
          retailers,
        }
      : null;

  // Only a new-condition offer may stand in for the item; anything else is
  // returned separately and labeled.
  const newOffers = productOffers.filter(
    (o) => isPurchasableCondition(o) && o.inStock && o.priceCents > 0,
  );
  const newOffer =
    newOffers.find((o) => o._id === item.offerId) ??
    newOffers.slice().sort((a, b) => a.priceCents - b.priceCents)[0] ??
    null;
  const alternates = (offer ? [offer] : []).flatMap((o) =>
    (o.alternates ?? []).map((a) => ({
      conditionClass: a.conditionClass,
      condition: a.condition ?? null,
      seller: a.seller ?? null,
      priceCents: a.priceCents ?? null,
      sourceUrl: a.sourceUrl,
      observedAt: a.observedAt,
    })),
  );
  const offerAvailability = {
    newOfferAvailable: newOffer !== null,
    note:
      newOffer !== null
        ? alternates.length > 0
          ? `Also listed at this URL, not shown as the item: ${alternates
              .map(
                (a) =>
                  `${a.condition ?? a.conditionClass} from ${a.seller ?? "an unknown seller"}${
                    a.priceCents !== null ? " at $" + (a.priceCents / 100).toFixed(2) : ""
                  }`,
              )
              .join("; ")}.`
          : null
        : `No new-condition offer is available for this URL.${
            alternates.length > 0
              ? ` The live page lists ${alternates
                  .map(
                    (a) =>
                      `${a.condition ?? a.conditionClass} from ${a.seller ?? "an unknown seller"}${
                        a.priceCents !== null ? " at $" + (a.priceCents / 100).toFixed(2) : ""
                      }`,
                  )
                  .join("; ")}.`
              : ""
          }`,
  };

  const comparisonRow = await ctx.db
    .query("priceComparisons")
    .withIndex("by_cartItemId", (q) => q.eq("cartItemId", item._id))
    .order("desc")
    .take(1);
  const latest = comparisonRow[0] ?? null;
  const verified = (latest?.offers ?? []).filter((o) => o.rejectedReason === null && o.verifiedAt !== null);
  const comparisonView = latest
    ? {
        status: latest.status,
        checkedAt: latest.checkedAt ?? null,
        subjectUrl: latest.subjectUrl,
        exaRunId: latest.exaRunId ?? null,
        note: latest.note ?? null,
        // Listing prices only: shipping is kept apart and totals are not computed here.
        offers: verified.map((o) => ({
          retailer: o.retailer,
          seller: o.seller ?? null,
          productUrl: o.productUrl,
          matchedIdentifier: o.matchedIdentifier ?? null,
          condition: o.condition ?? null,
          priceCents: o.priceCents ?? null,
          currency: o.currency ?? null,
          availability: o.availability ?? null,
          shippingCents: o.shippingCents ?? null,
          verifiedAt: o.verifiedAt ?? null,
          supportingSource: o.supportingSource ?? null,
        })),
        rejected: (latest.offers ?? [])
          .filter((o) => o.rejectedReason !== null)
          .map((o) => ({ retailer: o.retailer, productUrl: o.productUrl, reason: o.rejectedReason })),
      }
    : null;

  const evidenceDocs = await ctx.db
    .query("evidence")
    .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", item._id))
    .take(10);

  const totals = offer ? estimateTotals(offer.priceCents, offer.shippingCents, item.quantity) : null;
  const target = item.decision?.targetCents;
  const compareTo =
    totals && target !== undefined
      ? item.decision?.targetAppliesTo === "item_price"
        ? offer!.priceCents
        : totals.totalCents
      : null;

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
      ? {
          ...base,
          scope: e.scope,
          highlights: e.highlights,
          sources: e.sources,
          details: e.details ?? null,
          error: e.error ?? null,
        }
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
    newOffer: newOffer ? offerView(newOffer, variantLabels.get(newOffer.variantId) ?? null) : null,
    offerAvailability,
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
    comparison: comparisonView,
    priceHistory: offer
      ? await priceHistoryFor(
          ctx,
          offer,
          evidenceDocs.find((e) => e.section === "priceHistory") ?? null,
        )
      : null,
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
