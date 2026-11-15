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

const EXA_SEARCH = "https://api.exa.ai/search";

/**
 * Reddit fallback: Reddit blocks requests from our cloud IPs, so when the direct
 * JSON fetch fails we ask Exa for reddit.com results. Dates and authors are
 * reported only when Exa returns them; nothing is invented.
 */
export const searchReddit = internalAction({
  args: { query: v.string() },
  returns: v.object({
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    threads: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        author: v.union(v.string(), v.null()),
        createdAt: v.union(v.number(), v.null()),
        quote: v.union(v.string(), v.null()),
      }),
    ),
  }),
  handler: async (_ctx, { query }) => {
    const key = env.EXA_API_KEY;
    if (!key) return { ok: false, error: "EXA_API_KEY is not set", threads: [] };
    let res: Response;
    try {
      res = await fetch(EXA_SEARCH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query,
          numResults: 6,
          includeDomains: ["reddit.com"],
          type: "auto",
        }),
      });
    } catch (e) {
      return { ok: false, error: `Exa search failed: ${e instanceof Error ? e.message : String(e)}`, threads: [] };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Exa search HTTP ${res.status}: ${text.slice(0, 160)}`, threads: [] };
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "Exa search returned non-JSON", threads: [] };
    }
    const results = Array.isArray(body?.results) ? body.results : [];
    const threads = results
      .filter((r: any) => typeof r?.url === "string" && r.url.includes("reddit.com"))
      .slice(0, 5)
      .map((r: any) => ({
        title: typeof r?.title === "string" && r.title.trim() ? r.title.trim() : "Reddit thread",
        url: r.url as string,
        author: asString(r?.author),
        createdAt: asString(r?.publishedDate) ? Date.parse(r.publishedDate) : null,
        quote: asString(r?.summary) ?? asString(r?.text)?.slice(0, 240) ?? null,
      }));
    return {
      ok: threads.length > 0,
      error: threads.length > 0 ? null : "Exa returned no reddit.com results",
      threads,
    };
  },
});

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

const REDDIT_SCHEMA = {
  type: "object",
  properties: {
    threads: {
      type: "array",
      description: "Reddit discussion threads about this product, only reddit.com URLs",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          url: { type: "string", description: "reddit.com thread URL" },
          author: { type: ["string", "null"], description: "Reddit username if the page shows one" },
          createdAt: { type: ["string", "null"], description: "ISO date the thread was posted, if shown" },
          subreddit: { type: ["string", "null"] },
          quote: { type: ["string", "null"], description: "Short verbatim excerpt from the thread" },
        },
        required: ["title", "url"],
      },
    },
  },
  required: ["threads"],
} as const;

/**
 * Reddit blocks our cloud IPs, so the social section falls back to an Exa agent
 * run restricted to reddit.com. The run id is stored on the evidence row and the
 * result is published by a separate polling step.
 */
export const startRedditLookup = internalAction({
  args: { cartItemId: v.id("cartItems"), productTitle: v.string() },
  handler: async (ctx, { cartItemId, productTitle }) => {
    const existing = await ctx.runQuery(internal.exa.pendingRedditRun, { cartItemId });
    if (existing) return null;
    const key = env.EXA_API_KEY;
    if (!key) return null;
    const query =
      `Find discussion threads on reddit.com about "${productTitle}", especially real owner experience: ` +
      `long-term use, comfort, reliability and anything that would change a buying decision. ` +
      `Return only reddit.com URLs with the thread title, author and posting date when the page shows them.`;
    let runId: string | null = null;
    try {
      const res = await fetch(EXA_RUNS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({ query, effort: "auto", outputSchema: REDDIT_SCHEMA }),
      });
      if (res.ok) {
        const body = await res.json();
        runId = asString(body?.id);
      }
    } catch (e) {
      console.warn("Exa reddit lookup failed", String(e));
    }
    if (!runId) return null;
    await ctx.runMutation(internal.exa.setPendingRun, { cartItemId, runId });
    await ctx.scheduler.runAfter(POLL_MS, internal.exa.pollRedditLookup, {
      cartItemId,
      runId,
      attempt: 0,
    });
    return null;
  },
});

export const pollRedditLookup = internalAction({
  args: { cartItemId: v.id("cartItems"), runId: v.string(), attempt: v.number() },
  handler: async (ctx, { cartItemId, runId, attempt }) => {
    const key = env.EXA_API_KEY;
    if (!key) return null;
    let body: any = null;
    try {
      const res = await fetch(`${EXA_RUNS}/${runId}`, { headers: { "x-api-key": key } });
      if (res.ok) body = await res.json();
    } catch (e) {
      console.warn("Exa reddit poll failed", runId, String(e));
    }
    const status = asString(body?.status);
    if (body && (status === "completed" || status === "succeeded")) {
      const threads = Array.isArray(body?.output?.structured?.threads)
        ? body.output.structured.threads.filter((t: any) => typeof t?.url === "string" && t.url.includes("reddit.com"))
        : [];
      if (threads.length === 0) {
        await ctx.runMutation(internal.enrichment.failRedditRun, {
          cartItemId,
          reason: "Exa returned no reddit.com threads",
        });
        return null;
      }
      await ctx.runMutation(internal.enrichment.publishSection, {
        cartItemId,
        section: "reddit",
        summary: `${threads.length} Reddit threads found through Exa.`,
        highlights: threads.slice(0, 5).map((t: any) => ({
          label: asString(t.subreddit) ?? "reddit.com",
          detail: asString(t.quote) ?? String(t.title ?? "Reddit thread"),
          tone: "neutral" as const,
        })),
        sources: threads.slice(0, 5).map((t: any) => ({
          title: String(t.title ?? "Reddit thread"),
          url: String(t.url),
          publisher: "Reddit",
        })),
        simulated: false,
        items: threads.slice(0, 5).map((t: any) => ({
          author: asString(t.author),
          text: asString(t.quote) ?? String(t.title ?? "Reddit thread"),
          url: String(t.url),
          createdAt: asString(t.createdAt) ? Date.parse(t.createdAt) : null,
          score: null,
          community: asString(t.subreddit),
        })),
      });
      return null;
    }
    if (body && (status === "failed" || status === "canceled" || status === "error")) {
      await ctx.runMutation(internal.enrichment.failRedditRun, {
        cartItemId,
        reason: `Exa reddit run ${status}`,
      });
      return null;
    }
    if (attempt >= 20) {
      await ctx.runMutation(internal.enrichment.failRedditRun, {
        cartItemId,
        reason: "Exa reddit run did not finish in time",
      });
      return null;
    }
    await ctx.scheduler.runAfter(POLL_MS, internal.exa.pollRedditLookup, {
      cartItemId,
      runId,
      attempt: attempt + 1,
    });
    return null;
  },
});

export const pendingRedditRun = internalQuery({
  args: { cartItemId: v.id("cartItems") },
  handler: async (ctx, { cartItemId }) => {
    const ev = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId).eq("section", "reddit"))
      .unique();
    return ev?.pendingRun ?? null;
  },
});

export const setPendingRun = internalMutation({
  args: { cartItemId: v.id("cartItems"), runId: v.string() },
  handler: async (ctx, { cartItemId, runId }) => {
    const ev = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", cartItemId).eq("section", "reddit"))
      .unique();
    if (ev) await ctx.db.patch("evidence", ev._id, { pendingRun: runId });
    return null;
  },
});

const RETAILER_NAMES: Record<string, string> = {
  "amazon.com": "Amazon",
  "bestbuy.com": "Best Buy",
  "walmart.com": "Walmart",
  "target.com": "Target",
  "bhphotovideo.com": "B&H Photo Video",
  "adorama.com": "Adorama",
  "newegg.com": "Newegg",
  "costco.com": "Costco",
};

const priceFromText = (text: string | null): number | null => {
  if (!text) return null;
  const m = text.match(/\$\s?([0-9][0-9,]{0,6})(?:\.([0-9]{2}))?/);
  if (!m) return null;
  const cents = Math.round(Number(m[1].replace(/,/g, "") + "." + (m[2] ?? "00")) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
};

/**
 * Resolves a free-text product query ("sony xm5") to concrete product URLs so the
 * cart's title field can go through the same add pipeline as a pasted link.
 */
export const resolveProductQuery = internalAction({
  args: { query: v.string() },
  returns: v.object({
    ok: v.boolean(),
    error: v.union(v.string(), v.null()),
    candidates: v.array(
      v.object({
        title: v.string(),
        url: v.string(),
        retailer: v.string(),
        priceCents: v.union(v.number(), v.null()),
      }),
    ),
  }),
  handler: async (_ctx, { query }) => {
    const key = env.EXA_API_KEY;
    if (!key) return { ok: false, error: "EXA_API_KEY is not set", candidates: [] };
    let res: Response;
    try {
      res = await fetch(EXA_SEARCH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify({
          query: query + " product page price",
          numResults: 6,
          type: "auto",
          excludeDomains: ["reddit.com", "youtube.com", "wikipedia.org"],
        }),
      });
    } catch (e) {
      return { ok: false, error: `Exa search failed: ${e instanceof Error ? e.message : String(e)}`, candidates: [] };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `Exa search HTTP ${res.status}: ${text.slice(0, 160)}`, candidates: [] };
    let body: any;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "Exa search returned non-JSON", candidates: [] };
    }
    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    const candidates = results
      .filter((r) => typeof r?.url === "string" && /^https?:\/\//.test(r.url))
      .map((r) => {
        const host = new URL(r.url).hostname.replace(/^www\./, "");
        const retailer = RETAILER_NAMES[host] ?? host;
        const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url;
        return {
          title,
          url: r.url as string,
          retailer,
          priceCents: priceFromText(asString(r?.summary) ?? asString(r?.text)) ?? null,
        };
      })
      .slice(0, 4);
    return {
      ok: candidates.length > 0,
      error: candidates.length > 0 ? null : "Exa returned no product pages",
      candidates,
    };
  },
});
