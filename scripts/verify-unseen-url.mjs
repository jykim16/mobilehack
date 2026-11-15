#!/usr/bin/env node
// The real test: a URL the backend has never seen, with no demoKey, must produce a
// real offer, real evidence sections, real return terms and a verified comparison.
// Usage: node scripts/verify-unseen-url.mjs [convexUrl] [url]
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
const DEFAULT_URL = "https://hearty-skunk-641.convex.cloud";
const fromEnvFile = () =>
  existsSync(".env.local")
    ? readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)/m)?.[1]?.trim()
    : undefined;
const url = process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL ?? fromEnvFile() ?? DEFAULT_URL;
const target = process.argv[3] ?? "https://www.walmart.com/ip/Sony-WH-1000XM5-The-Best-Wireless-Noise-Canceling-Headphones-Black/386006068";
console.log("target:", url, "\nunseen product:", target);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

const c = new ConvexHttpClient(url);
c.setAuth((await c.action(api.auth.signIn, { provider: "anonymous" })).tokens.token);
await c.mutation(api.demo.resetDemo, {});
await c.mutation(api.demo.setupMyCart, {});

const { itemId } = await c.mutation(api.cart.addItem, { url: target, idempotencyKey: "unseen-" + Date.now() });
let item;
let sections = {};
let comparison = null;
for (let i = 0; i < 120; i++) {
  item = await c.query(api.cart.getItem, { itemId });
  sections = Object.fromEntries(item.sections.map((s) => [s.section, s]));
  comparison = item.comparison;
  const terminal = (s) => s && ["ready", "failed"].includes(s.status);
  const done = item.offer?.provenance?.method === "firecrawl" &&
    ["categoryGuidance", "returnTerms", "retailerReviews", "priceHistory"].every((k) => terminal(sections[k])) &&
    comparison && ["completed", "empty", "failed"].includes(comparison.status);
  if (done) break;
  await sleep(3000);
}

console.log("   offer:", JSON.stringify({
  title: item.product?.title,
  seller: item.offer?.seller,
  condition: item.offer?.condition,
  price: item.offer?.priceCents,
  simulated: item.offer?.simulated,
  provenance: item.offer?.provenance?.method,
  observations: item.priceHistory?.observationCount,
  mode: item.priceHistory?.mode,
}));
console.log("   sections:", JSON.stringify(Object.fromEntries(
  Object.entries(sections).map(([k, v]) => [k, { status: v.status, simulated: v.simulated }]),
)));
console.log("   comparison:", JSON.stringify({
  status: comparison?.status,
  verified: comparison?.offers?.length ?? 0,
  rejected: comparison?.rejected?.length ?? 0,
  offers: (comparison?.offers ?? []).map((o) => `${o.retailer} ${o.priceCents}`),
}));

check("product came from the page, not a seed", item.offer?.provenance?.method === "firecrawl", String(item.offer?.provenance?.method));
check("the offer is not simulated", item.offer?.simulated === false);
check("the offer has a real price", (item.offer?.priceCents ?? 0) > 0, String(item.offer?.priceCents));
check("the product has no demoKey", item.offer?.simulated === false);
check("category guidance is real", sections.categoryGuidance?.status === "ready" && sections.categoryGuidance?.simulated === false, sections.categoryGuidance?.status);
check("category guidance surfaces one overlooked criterion", (sections.categoryGuidance?.highlights ?? []).some((h) => h.tone === "new_criterion"));
check("return terms are real", sections.returnTerms?.status === "ready" && sections.returnTerms?.simulated === false, sections.returnTerms?.status);
check("return terms carry structured details", sections.returnTerms?.details?.status === "confirmed" || sections.returnTerms?.details?.status === "unconfirmed");
check("retailer reviews are real", sections.retailerReviews?.status === "ready", sections.retailerReviews?.status);
check("price history recorded a real observation", (item.priceHistory?.observationCount ?? 0) > 0, String(item.priceHistory?.observationCount));
check("no section fell back to seeded demo data", Object.values(sections).every((s) => s.simulated === false), JSON.stringify(Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.simulated]))));
check("the comparison resolved", comparison && ["completed", "empty", "failed"].includes(comparison.status), comparison?.status);
if (comparison?.status === "completed") {
  check("comparison offers carry prices and are labeled as Exa-reported", comparison.offers.every((o) => (o.priceCents ?? 0) > 0 && o.reportedBy === "exa"));
}

let req = null;
let refused = null;
try {
  req = await c.action(api.purchases.requestPurchase, {
    itemId,
    offerId: item.offer.id,
    quantity: 1,
    reason: "unseen URL end-to-end",
    idempotencyKey: "unseen-req-" + Date.now(),
  });
} catch (e) {
  refused = e?.data?.code ?? String(e);
}
check(
  "the unseen item can be quoted",
  req !== null && req.status === "pending_approval" && (req.quote?.totalCents ?? 0) > 0,
  refused ? `refused: ${refused}` : `${req?.status} ${req?.quote?.totalCents}`,
);

console.log(failures === 0 ? "\nALL UNSEEN-URL CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
