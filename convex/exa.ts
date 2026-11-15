import { v } from "convex/values";
import { env, internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { classifyCondition, isWithheldCondition } from "./lib/conditions";

const EXA_RUNS = "https://api.exa.ai/agent/runs";
const POLL_MS = 8_000;
const MAX_POLLS = 40;

/** Structured output we ask the Exa agent for: up to three other-retailer offers. */
const COMPARISON_SCHEMA = {
  type: "object",
  properties: {
    offers: {
      type: "array",
      description: "Up to three in-stock offers from other retailers for this exact product",
      items: {
        type: "object",
        properties: {
          retailer: { type: "string" },
          seller: { type: ["string", "null"] },
          productUrl: { type: "string", description: "Direct product listing URL at that retailer" },
          matchedIdentifier: { type: ["string", "null"], description: "UPC, model number or ASIN that proves the match" },
          condition: { type: ["string", "null"] },
          price: { type: ["number", "null"], description: "Listing price in the stated currency" },
          currency: { type: ["string", "null"] },
          availability: { type: ["string", "null"] },
          supportingSource: { type: ["string", "null"], description: "URL you read the price from" },
        },
        required: ["retailer", "productUrl"],
      },
    },
  },
  required: ["offers"],
} as const;

const candidateValidator = v.object({
  retailer: v.string(),
  seller: v.union(v.string(), v.null()),
  productUrl: v.string(),
  matchedIdentifier: v.union(v.string(), v.null()),
  condition: v.union(v.string(), v.null()),
  priceCents: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  availability: v.union(v.string(), v.null()),
  supportingSource: v.union(v.string(), v.null()),
});

const offerValidator = v.object({
  retailer: v.string(),
  seller: v.union(v.string(), v.null()),
  productUrl: v.string(),
  matchedIdentifier: v.union(v.string(), v.null()),
  condition: v.union(v.string(), v.null()),
  priceCents: v.union(v.number(), v.null()),
  currency: v.union(v.string(), v.null()),
  availability: v.union(v.string(), v.null()),
  supportingSource: v.union(v.string(), v.null()),
  shippingCents: v.union(v.number(), v.null()),
  verifiedAt: v.union(v.number(), v.null()),
  reportedBy: v.optional(v.union(v.literal("exa"))),
  rejectedReason: v.union(v.string(), v.null()),
});

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normaliseCandidate(raw: any) {
  const price = typeof raw?.price === "number" ? raw.price : null;
  return {
    retailer: asString(raw?.retailer) ?? "unknown",
    seller: asString(raw?.seller),
    productUrl: asString(raw?.productUrl) ?? "",
    matchedIdentifier: asString(raw?.matchedIdentifier),
    condition: asString(raw?.condition),
    priceCents: price === null ? null : Math.round(price * 100),
    currency: asString(raw?.currency)?.toUpperCase().slice(0, 3) ?? null,
    availability: asString(raw?.availability),
    supportingSource: asString(raw?.supportingSource),
  };
}

/** Exa returns the schema-bound answer on output.structured, with citations in output.grounding. */
function offersFromResponse(body: any) {
  const output = body?.output ?? {};
  const structured = output.structured ?? body?.structured ?? null;
  const offers = Array.isArray(structured?.offers)
    ? structured.offers
    : Array.isArray(body?.offers)
      ? body.offers
      : [];
  const grounding = Array.isArray(output.grounding) ? output.grounding : [];
  return offers.slice(0, 3).map((raw: any, index: number) => {
    const candidate = normaliseCandidate(raw);
    const cited = grounding.find((g: any) => g?.field === `structured.offers[${index}]`)?.citations?.[0]?.url;
    return {
      ...candidate,
      supportingSource: candidate.supportingSource ?? (typeof cited === "string" ? cited : null),
    };
  });
}

/**
 * Starts an Exa Agent run that hunts other retailers for the same product. The
 * run id is persisted so polling happens in its own step.
 */
export const startLookup = internalAction({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const key = env.EXA_API_KEY;
    const context = await ctx.runQuery(internal.exa.itemContext, { cartItemId });
    if (!context) return null;
    if (!key) {
      await ctx.runMutation(internal.exa.saveComparison, {
        cartItemId,
        subjectUrl: context.url,
        query: "",
        status: "failed",
        note: "EXA_API_KEY is not set on this deployment, so no cross-store comparison was requested.",
        candidates: [],
      });
      return null;
    }
    const identifier = [context.brand, context.title].filter(Boolean).join(" ");
    const query =
      `Find up to three in-stock offers from OTHER retailers for exactly this product: ${context.url}. ` +
      `Product: ${identifier}. Match the same model, variant and condition (${context.condition ?? "new"}). ` +
      `Prefer the retailer's own product page. Return the listing price, currency and availability, ` +
      `and leave anything you cannot verify as null. Exclude bundles, accessories and refurbished listings.`;
    let runId: string | null = null;
    try {
      const res = await fetch(EXA_RUNS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, effort: "auto", outputSchema: COMPARISON_SCHEMA }),
      });
      const text = await res.text();
      if (!res.ok) {
        await ctx.runMutation(internal.exa.saveComparison, {
          cartItemId,
          subjectUrl: context.url,
          query,
          status: "failed",
          note: `Exa rejected the run: HTTP ${res.status} ${text.slice(0, 160)}`,
          candidates: [],
        });
        return null;
      }
      const body = JSON.parse(text);
      runId = asString(body?.id);
      const immediate = body?.status === "completed" ? offersFromResponse(body) : [];
      await ctx.runMutation(internal.exa.saveComparison, {
        cartItemId,
        subjectUrl: context.url,
        query,
        status: immediate.length > 0 ? "verifying" : "running",
        exaRunId: runId ?? undefined,
        note: null,
        candidates: immediate,
      });
    } catch (e) {
      await ctx.runMutation(internal.exa.saveComparison, {
        cartItemId,
        subjectUrl: context.url,
        query,
        status: "failed",
        note: `Exa request failed: ${e instanceof Error ? e.message : String(e)}`,
        candidates: [],
      });
      return null;
    }
    const comparison = await ctx.runQuery(internal.exa.latestForItem, { cartItemId });
    if (comparison && comparison.candidates.length > 0) {
      await ctx.scheduler.runAfter(0, internal.exa.acceptCandidates, { comparisonId: comparison._id });
    }
    if (runId) {
      await ctx.scheduler.runAfter(POLL_MS, internal.exa.pollLookup, { comparisonId: comparison!._id, attempt: 0 });
    }
    return null;
  },
});

/** Polls the Exa run, then hands any candidates to the Firecrawl verifier. */
export const pollLookup = internalAction({
  args: { comparisonId: v.id("priceComparisons"), attempt: v.number() },
  handler: async (ctx, { comparisonId, attempt }) => {
    const comparison = await ctx.runQuery(internal.exa.getComparison, { comparisonId });
    if (!comparison || comparison.status === "completed" || comparison.status === "empty") return null;
    const key = env.EXA_API_KEY;
    if (!key || !comparison.exaRunId) return null;
    let body: any = null;
    try {
      const res = await fetch(`${EXA_RUNS}/${comparison.exaRunId}`, {
        headers: { "x-api-key": key },
      });
      if (res.ok) body = await res.json();
    } catch (e) {
      console.warn("Exa poll failed", comparison.exaRunId, String(e));
    }
    const status = asString(body?.status);
    if (body && (status === "completed" || status === "succeeded")) {
      const candidates = offersFromResponse(body);
      await ctx.runMutation(internal.exa.setCandidates, { comparisonId, candidates });
      if (candidates.length === 0) {
        await ctx.runMutation(internal.exa.finish, {
          comparisonId,
          status: "empty",
          note: "No verified comparison yet",
        });
        return null;
      }
      await ctx.scheduler.runAfter(0, internal.exa.acceptCandidates, { comparisonId });
      return null;
    }
    if (body && (status === "failed" || status === "canceled" || status === "error")) {
      await ctx.runMutation(internal.exa.finish, {
        comparisonId,
        status: "failed",
        note: `Exa run ${status}`,
      });
      return null;
    }
    if (attempt >= MAX_POLLS) {
      await ctx.runMutation(internal.exa.finish, {
        comparisonId,
        status: "empty",
        note: "No verified comparison yet (Exa run did not finish in time)",
      });
      return null;
    }
    await ctx.runMutation(internal.exa.bumpAttempt, { comparisonId });
    await ctx.scheduler.runAfter(POLL_MS, internal.exa.pollLookup, {
      comparisonId,
      attempt: attempt + 1,
    });
    return null;
  },
});

/**
 * Accepts the agent's own report: no re-scraping. Candidates are matched to the
 * saved product from what Exa returned (its matched identifier, or the model
 * tokens in the URL) and any used or refurbished listing is dropped when the
 * saved item is new. Every accepted row is labeled as reported by Exa.
 */
export const acceptCandidates = internalAction({
  args: { comparisonId: v.id("priceComparisons") },
  handler: async (ctx, { comparisonId }) => {
    const comparison = await ctx.runQuery(internal.exa.getComparison, { comparisonId });
    if (!comparison) return null;
    const context = await ctx.runQuery(internal.exa.itemContext, { cartItemId: comparison.cartItemId });
    if (!context) return null;
    const savedIsNew = !isWithheldCondition({ condition: context.condition ?? undefined });
    const modelTokens = String(context.title ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 5 && /\d/.test(t));
    for (const candidate of comparison.candidates) {
      if (!candidate.productUrl.startsWith("https://")) continue;
      const already = await ctx.runQuery(internal.exa.hasOffer, {
        comparisonId,
        productUrl: candidate.productUrl,
      });
      if (already) continue;
      const checkedAt = Date.now();
      const url = candidate.productUrl.toLowerCase();
      // Match on what Exa itself reported: an explicit identifier, or the model
      // tokens from the saved product appearing in the listing URL.
      const matchesProduct =
        candidate.matchedIdentifier !== null ||
        modelTokens.some((token) => url.includes(token));
      if (!matchesProduct) {
        await ctx.runMutation(internal.exa.addOffer, {
          comparisonId,
          offer: {
            ...candidate,
            shippingCents: null,
            verifiedAt: checkedAt,
            reportedBy: "exa" as const,
            rejectedReason: "Exa did not tie this listing to the saved product",
          },
        });
        continue;
      }
      const condClass = classifyCondition(candidate.condition);
      if (savedIsNew && isWithheldCondition({ condition: candidate.condition ?? undefined, conditionClass: condClass })) {
        await ctx.runMutation(internal.exa.addOffer, {
          comparisonId,
          offer: {
            ...candidate,
            shippingCents: null,
            verifiedAt: checkedAt,
            reportedBy: "exa" as const,
            rejectedReason: `Listing is ${candidate.condition ?? "used"}, not new like the saved item`,
          },
        });
        continue;
      }
      if (candidate.priceCents === null || candidate.priceCents <= 0) {
        await ctx.runMutation(internal.exa.addOffer, {
          comparisonId,
          offer: {
            ...candidate,
            shippingCents: null,
            verifiedAt: checkedAt,
            reportedBy: "exa" as const,
            rejectedReason: "Exa reported no price",
          },
        });
        continue;
      }
      await ctx.runMutation(internal.exa.addOffer, {
        comparisonId,
        offer: {
          ...candidate,
          currency: candidate.currency ?? "USD",
          shippingCents: null,
          verifiedAt: checkedAt,
          reportedBy: "exa" as const,
          rejectedReason: null,
        },
      });
    }
    const after = await ctx.runQuery(internal.exa.getComparison, { comparisonId });
    const verified = (after?.offers ?? []).filter((o) => o.rejectedReason === null);
    await ctx.runMutation(internal.exa.finish, {
      comparisonId,
      status: verified.length > 0 ? "completed" : "empty",
      note: verified.length > 0 ? null : "No verified comparison yet",
    });
    return null;
  },
});

export const itemContext = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const item = await ctx.db.get("cartItems", cartItemId);
    if (!item) return null;
    const product = item.productId ? await ctx.db.get("products", item.productId) : null;
    const offer = item.offerId ? await ctx.db.get("offers", item.offerId) : null;
    return {
      url: item.url,
      title: product?.title ?? null,
      brand: product?.brand ?? null,
      condition: offer?.condition ?? null,
      offerId: offer?._id ?? null,
    };
  },
});

export const latestForItem = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const rows = await ctx.db
      .query("priceComparisons")
      .withIndex("by_cartItemId", (q) => q.eq("cartItemId", cartItemId))
      .order("desc")
      .take(1);
    return rows[0] ?? null;
  },
});

export const getComparison = internalQuery({
  args: { comparisonId: v.id("priceComparisons") },
  handler: async (ctx, { comparisonId }) => await ctx.db.get("priceComparisons", comparisonId),
});

export const hasOffer = internalQuery({
  args: { comparisonId: v.id("priceComparisons"), productUrl: v.string() },
  handler: async (ctx, { comparisonId, productUrl }) => {
    const row = await ctx.db.get("priceComparisons", comparisonId);
    return !!row?.offers.some((o) => o.productUrl === productUrl);
  },
});

export const saveComparison = internalMutation({
  args: {
    cartItemId: v.id("cartItems"),
    subjectUrl: v.string(),
    query: v.string(),
    status: v.union(
      v.literal("running"),
      v.literal("verifying"),
      v.literal("completed"),
      v.literal("empty"),
      v.literal("failed"),
    ),
    exaRunId: v.optional(v.string()),
    note: v.union(v.string(), v.null()),
    candidates: v.array(candidateValidator),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get("cartItems", args.cartItemId);
    if (!item) return null;
    return await ctx.db.insert("priceComparisons", {
      shopperId: item.shopperId,
      cartItemId: args.cartItemId,
      subjectUrl: args.subjectUrl,
      query: args.query,
      exaRunId: args.exaRunId,
      status: args.status,
      attempts: 0,
      checkedAt: Date.now(),
      note: args.note ?? undefined,
      candidates: args.candidates,
      offers: [],
    });
  },
});

export const setCandidates = internalMutation({
  args: { comparisonId: v.id("priceComparisons"), candidates: v.array(candidateValidator) },
  handler: async (ctx, { comparisonId, candidates }) => {
    await ctx.db.patch("priceComparisons", comparisonId, { candidates, checkedAt: Date.now() });
    return null;
  },
});

export const addOffer = internalMutation({
  args: { comparisonId: v.id("priceComparisons"), offer: offerValidator },
  handler: async (ctx, { comparisonId, offer }) => {
    const row = await ctx.db.get("priceComparisons", comparisonId);
    if (!row) return null;
    const offers = [...row.offers.filter((o) => o.productUrl !== offer.productUrl), offer];
    await ctx.db.patch("priceComparisons", comparisonId, {
      offers,
      status: "verifying",
      checkedAt: Date.now(),
    });
    return null;
  },
});

export const bumpAttempt = internalMutation({
  args: { comparisonId: v.id("priceComparisons") },
  handler: async (ctx, { comparisonId }) => {
    const row = await ctx.db.get("priceComparisons", comparisonId);
    if (row) await ctx.db.patch("priceComparisons", comparisonId, { attempts: row.attempts + 1 });
    return null;
  },
});

export const finish = internalMutation({
  args: {
    comparisonId: v.id("priceComparisons"),
    status: v.union(
      v.literal("running"),
      v.literal("verifying"),
      v.literal("completed"),
      v.literal("empty"),
      v.literal("failed"),
    ),
    note: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { comparisonId, status, note }) => {
    await ctx.db.patch("priceComparisons", comparisonId, {
      status,
      note: note ?? undefined,
      checkedAt: Date.now(),
    });
    return null;
  },
});
