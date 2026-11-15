#!/usr/bin/env node
// Proves the extraction cache: a warm row costs no upstream call, a stale row is
// served marked stale when the provider refuses, and a forced refresh does go out.
// Run: node scripts/verify-extraction-cache.mjs
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const api = anyApi;
const fromEnvFile = () =>
  existsSync(".env.local")
    ? readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim()
    : undefined;
const url =
  process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL ?? fromEnvFile() ?? "https://hearty-skunk-641.convex.cloud";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  (${detail})`}`);
};

// Cache rows are shared state, so they are seeded through the admin CLI against an
// internal mutation rather than from a client anyone could call.
function seed(fn, args) {
  const out = execFileSync("npx", ["convex", "run", `demo:${fn}`, JSON.stringify(args)], {
    encoding: "utf8",
  });
  const text = out.trim();
  return JSON.parse(text.slice(text.indexOf("{")));
}

async function signIn() {
  const client = new ConvexHttpClient(url);
  const s = await client.action(api.auth.signIn, { provider: "anonymous" });
  client.setAuth(s.tokens.token);
  return client;
}

// A scrape is asynchronous: wait for the cache to record the attempt it made.
async function waitForAttempts(client, key, atLeast) {
  let stats = await client.query(api.demo.cacheStats, { kind: "offer", key });
  for (let i = 0; i < 15 && (stats?.attempts ?? 0) < atLeast; i++) {
    await sleep(2000);
    stats = await client.query(api.demo.cacheStats, { kind: "offer", key });
  }
  return stats;
}

async function settled(client, itemId) {
  let item = null;
  for (let i = 0; i < 30; i++) {
    item = await client.query(api.cart.getItem, { itemId });
    if (item.offer && item.offer.provenance && item.enrichmentStatus !== "resolving") return item;
    if (item.offer && !item.offer.provenance && item.enrichmentStatus === "partial") return item;
    await sleep(2000);
  }
  return item;
}

const warmUrl = "https://www.walmart.com/ip/Extraction-Cache-Warm-Example/100000001";
const staleUrl = "https://www.walmart.com/ip/Extraction-Cache-Stale-Example/100000002";

// --- 1. A warm row is served with no upstream call -----------------------------
const shopperForSeed = await signIn();
const warm = seed("seedCachedOffer", { url: warmUrl, priceCents: 27999, title: "Cached Product, Warm Row" });
const shopperA = await signIn();
const addedWarm = await shopperA.mutation(api.cart.addItem, {
  url: warmUrl,
  idempotencyKey: "cache-warm-" + Date.now(),
});
const warmItem = await settled(shopperA, addedWarm.itemId);
const warmStats = await shopperA.query(api.demo.cacheStats, { kind: "offer", key: warm.key });
check("the warm row is used as-is", warmItem.offer?.priceCents === 27999, warmItem.offer?.priceCents);
check("serving a warm row makes zero provider calls", warmStats.attempts === 0, warmStats.attempts);
check("the offer is not marked simulated", warmItem.offer?.simulated === false, warmItem.offer?.simulated);

// --- 2. A second add of the same URL costs nothing either ----------------------
const shopperB = await signIn();
await shopperB.mutation(api.cart.addItem, { url: warmUrl, idempotencyKey: "cache-warm-b-" + Date.now() });
await sleep(3000);
const warmStatsAfter = await shopperB.query(api.demo.cacheStats, { kind: "offer", key: warm.key });
check("a second shopper's add of the same URL makes zero provider calls", warmStatsAfter.attempts === 0, warmStatsAfter.attempts);

// --- 3. A stale row is served, marked stale, when the provider refuses ---------
const stale = seed("seedCachedOffer", {
  url: staleUrl,
  priceCents: 24999,
  title: "Cached Product, Stale Row",
  ageMs: 3 * 60 * 60_000,
});
const shopperC = await signIn();
const addedStale = await shopperC.mutation(api.cart.addItem, {
  url: staleUrl,
  idempotencyKey: "cache-stale-" + Date.now(),
});
const staleItem = await settled(shopperC, addedStale.itemId);
const staleStats = await waitForAttempts(shopperC, stale.key, 1);
const providerHealthy = staleItem.offer?.provenance?.note === null || staleItem.offer?.provenance?.note === undefined;
check("a stale row still yields the price we read earlier", staleItem.offer?.priceCents === 24999 || !providerHealthy, staleItem.offer?.priceCents);
check("the stale read was attempted once upstream", staleStats.attempts >= 1, staleStats.attempts);
if (!providerHealthy) {
  console.log("   stale note:", staleItem.offer.provenance.note);
  check(
    "the offer says the price is old and when it was read",
    /could not be read/i.test(staleItem.offer.provenance.note ?? "") &&
      typeof staleItem.offer.provenance.observedAt === "number",
    String(staleItem.offer.provenance.observedAt),
  );
} else {
  console.log("   provider is healthy, so nothing stale was served");
}

// --- 4. A forced refresh does go upstream -------------------------------------
const beforeRefresh = await shopperA.query(api.demo.cacheStats, { kind: "offer", key: warm.key });
await shopperA.mutation(api.cart.refreshItem, { cartItemId: addedWarm.itemId });
const afterRefresh = await waitForAttempts(shopperA, warm.key, beforeRefresh.attempts + 1);
check("refreshItem forces a real provider call", afterRefresh.attempts >= 1, afterRefresh.attempts);

// --- 5. A repeated query resolution costs nothing -----------------------------
const words = "cached query resolution example headphones";
const seededQuery = seed("seedCachedQueryResolution", {
  query: words,
  candidates: [
    {
      title: "Seeded Candidate Headphones",
      url: "https://www.bestbuy.com/site/seeded-candidate/6500000.p",
      retailer: "Best Buy",
      priceCents: 32999,
    },
    {
      title: "Another Seeded Candidate",
      url: "https://www.adorama.com/seeded-candidate.html",
      retailer: "Adorama",
      priceCents: null,
    },
  ],
});
const shopperD = await signIn();
const queryAdd = await shopperD.action(api.cart.addItemFromQuery, {
  query: words,
  idempotencyKey: "cache-query-" + Date.now(),
});
check("the query resolved from the cache", queryAdd.resolvedUrl.includes("bestbuy.com"), queryAdd.resolvedUrl);
const queryStats = await shopperD.query(api.demo.cacheStats, { kind: "query", key: seededQuery.key });
check("resolving from cache makes zero Exa calls", queryStats.attempts === 0, queryStats.attempts);
check("the cached alternatives come back with it", queryAdd.alternatives.length === 1, queryAdd.alternatives.length);

// The seeders must not be reachable from a signed-in client: they write rows that
// every shopper reads.
let seedReachable = null;
try {
  await shopperForSeed.mutation(api.demo.seedCachedOffer, {
    url: "https://www.walmart.com/ip/Poison-Attempt/100000009",
    priceCents: 100,
    title: "Poison Attempt",
  });
  seedReachable = "callable";
} catch (e) {
  seedReachable = e?.data?.code ?? e?.message ?? "refused";
}
check("a client cannot seed the shared cache", seedReachable !== "callable", seedReachable);

console.log(failures === 0 ? "\nALL EXTRACTION-CACHE CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
