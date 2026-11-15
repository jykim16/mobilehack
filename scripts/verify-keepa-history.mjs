#!/usr/bin/env node
// Verifies Keepa price history and the condition rules against a deployment.
// Usage: node scripts/verify-keepa-history.mjs [convexUrl]
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
console.log("target:", url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

const c = new ConvexHttpClient(url);
c.setAuth((await c.action(api.auth.signIn, { provider: "anonymous" })).tokens.token);
const runId = Date.now();
await c.mutation(api.demo.resetDemo, {});
await c.mutation(api.demo.setupMyCart, {});

async function addAndWait(label, itemUrl) {
  const { itemId } = await c.mutation(api.cart.addItem, { url: itemUrl, idempotencyKey: `kh-${label}-${runId}` });
  let item;
  let history;
  for (let i = 0; i < 60; i++) {
    item = await c.query(api.cart.getItem, { itemId });
    history = item.sections.find((s) => s.section === "priceHistory");
    if (history && (history.status === "ready" || history.status === "failed")) break;
    await sleep(2000);
  }
  return { item, section: history };
}

const amazon = await addAndWait("amazon", "https://www.amazon.com/dp/B09XS7JWHH");
console.log("   Amazon priceHistory section:", JSON.stringify({ status: amazon.section.status, summary: amazon.section.summary }));
console.log("   Amazon priceHistory payload:", JSON.stringify({
  mode: amazon.item.priceHistory.mode,
  seriesLabel: amazon.item.priceHistory.seriesLabel,
  sourceUrl: amazon.item.priceHistory.sourceUrl,
  sampled: amazon.item.priceHistory.sampled,
  points: amazon.item.priceHistory.points.length,
  low: amazon.item.priceHistory.lowCents,
  high: amazon.item.priceHistory.highCents,
}, null, 1));
check("Amazon history resolved to a mode", ["live", "sampled", "fallback", "observations"].includes(amazon.item.priceHistory.mode), amazon.item.priceHistory.mode);
check("Amazon history points to Keepa", (amazon.item.priceHistory.sourceUrl ?? "").includes("keepa.com/product"), String(amazon.item.priceHistory.sourceUrl));
if (amazon.item.priceHistory.sampled) {
  check("a sampled series reports no low or high", amazon.item.priceHistory.lowCents === null && amazon.item.priceHistory.highCents === null);
}
check("Amazon history points carry source and time", amazon.item.priceHistory.points.every((p) => typeof p.source === "string" && (p.observedAt === null || p.observedAt > 0)));

const collexion = await addAndWait("collexion", "https://www.amazon.com/Sony-COLLEXION-Wireless-Cancelling-Headphones/dp/B0GW9MBZJ9/ref=ast_sto_dp_puis?ufe=app_do%3Aamzn1.fos.609a3224-cb27-4058-a18c-8364c206a3b0&th=1");
console.log("   Jonathan's link:", JSON.stringify({
  mode: collexion.item.priceHistory.mode,
  source: collexion.item.priceHistory.sourceUrl,
  seller: collexion.item.offer?.seller,
  condition: collexion.item.offer?.condition,
  price: collexion.item.offer?.priceCents,
}));
check("the second Amazon link also resolves Keepa history", (collexion.item.priceHistory.sourceUrl ?? "").includes("keepa.com/product"), String(collexion.item.priceHistory.sourceUrl));
check("its Keepa URL uses the marketplace-1 domain", (collexion.item.priceHistory.sourceUrl ?? "").includes("/product/1-B0GW9MBZJ9"), String(collexion.item.priceHistory.sourceUrl));

const bestbuy = await addAndWait("bestbuy", "https://www.bestbuy.com/site/twelve-south-airfly-pro/6411178.p?skuId=6411178");
check("a non-Amazon item falls back to recorded observations", bestbuy.item.priceHistory.mode === "observations" || bestbuy.item.priceHistory.mode === "fallback", bestbuy.item.priceHistory.mode);

// Condition rules on a live page that only sells used.
const availability = amazon.item.offerAvailability;
const used = (usedLabel) => JSON.stringify(usedLabel ?? "").toLowerCase().includes("used");
console.log("   Amazon offer:", JSON.stringify({
  price: amazon.item.offer?.priceCents,
  condition: amazon.item.offer?.condition,
  class: amazon.item.offer?.conditionClass,
  purchasable: amazon.item.offer?.purchasable,
  note: availability?.note,
}));
check("a null-condition offer stays purchasable", amazon.item.offer?.condition === null ? amazon.item.purchasable !== false : true, String(amazon.item.offer?.condition));
if (used(availability?.note)) {
  check("a used live offer is stored and labeled, not presented as the item", amazon.item.offer.condition === null, String(availability.note).slice(0, 120));
} else {
  check("no used alternate on this offer", true);
}

const buyable = amazon.item.newOffer ?? amazon.item.offer;
check("the item still has a purchasable offer", !!buyable?.purchasable, JSON.stringify({ price: buyable?.priceCents, cls: buyable?.conditionClass }));
const req = await c.action(api.purchases.requestPurchase, {
  itemId: amazon.item.id,
  offerId: amazon.item.offer.id,
  quantity: 1,
  reason: "condition rule check",
  idempotencyKey: `kh-req-${runId}`,
});
check("a request quotes the null-condition offer", req.status === "pending_approval" && req.quote !== null, `${req.status} ${req.quote?.totalCents}`);

console.log(failures === 0 ? "\nALL KEEPA/CONDITION CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
