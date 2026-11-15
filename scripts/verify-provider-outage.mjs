#!/usr/bin/env node
// Verifies that an add whose listing cannot be read is honest: the URL is kept,
// no price is invented, the item says so, and a retry can be requested later.
// Run: node scripts/verify-provider-outage.mjs
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
const fromEnvFile = () =>
  existsSync(".env.local")
    ? readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim()
    : undefined;
const url =
  process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL ?? fromEnvFile() ?? "https://hearty-skunk-641.convex.cloud";
const client = new ConvexHttpClient(url);
const signIn = await client.action(api.auth.signIn, { provider: "anonymous" });
client.setAuth(signIn.tokens.token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  (${detail})`}`);
};
async function errorCode(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e?.data?.code ?? e?.cause?.data?.code ?? e?.message ?? "UNKNOWN";
  }
}

const target = "https://www.target.com/p/sony-wh-1000xm5-wireless-noise-canceling-headphones/-/A-84779785";
const added = await client.mutation(api.cart.addItem, { url: target, idempotencyKey: "outage-" + Date.now() });
let item;
for (let i = 0; i < 40; i++) {
  item = await client.query(api.cart.getItem, { itemId: added.itemId });
  if (item.enrichmentStatus !== "resolving" && item.offer && item.notice) break;
  await sleep(3000);
}

if (item.offer?.provenance?.method === "firecrawl" && (item.offer?.priceCents ?? 0) > 0) {
  console.log("\\nProviders are healthy: the listing was read, so there is no outage to verify.");
  process.exit(0);
}

console.log("   offer:", JSON.stringify(item.offer && { price: item.offer.priceCents, simulated: item.offer.simulated, purchasable: item.offer.purchasable }));
console.log("   notice:", item.notice);
check("the URL is kept even though the page could not be read", item.url === target, item.url);
check("the item says the listing could not be read", typeof item.notice === "string" && item.notice.length > 10, item.notice);
check("the item offers a retry", item.canRetry === true, String(item.canRetry));
check(
  "no price is presented as fetched when there is none",
  !item.offer || item.offer.priceCents <= 0 || item.offer.simulated === false,
  JSON.stringify({ price: item.offer?.priceCents, simulated: item.offer?.simulated }),
);
check("nothing unpurchasable is offered for sale", !item.offer || item.offer.purchasable === false);
check(
  "no section presents seeded numbers for a page we never read",
  item.sections.every((s) => s.simulated === false),
  item.sections.filter((s) => s.simulated).map((s) => s.section).join(","),
);

const retried = await client.mutation(api.cart.retryItem, { cartItemId: added.itemId });
check("a retry is accepted", retried?.retried === true, retried?.enrichmentStatus ?? retried?.retried ?? retried?.message ?? String(retried));
await sleep(4000);
const after = await client.query(api.cart.getItem, { itemId: added.itemId });
check(
  "the retry leaves the section retryable, not failed forever",
  after.sections.some((s) => s.status === "pending" || s.status === "running") || after.canRetry === true,
  after.sections.map((s) => `${s.section}:${s.status}`).join(" "),
);

await client.mutation(api.demo.resetDemo, {});
const { heroUrl } = await client.mutation(api.demo.setupMyCart, {});
const hero = await client.mutation(api.cart.addItem, { url: heroUrl, idempotencyKey: "outage-hero-" + Date.now() });
let heroItem = null;
for (let i = 0; i < 20; i++) {
  heroItem = await client.query(api.cart.getItem, { itemId: hero.itemId });
  if (heroItem.offer?.id) break;
  await sleep(1000);
}
const req = await client.action(api.purchases.requestPurchase, {
  itemId: hero.itemId,
  offerId: heroItem.offer.id,
  quantity: 1,
  reason: "verify retryItem refusing mid-checkout",
  idempotencyKey: "outage-req-" + Date.now(),
});
await client.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  decision: "approve",
});
const refused = await errorCode(() => client.mutation(api.cart.retryItem, { cartItemId: hero.itemId }));
check("an approved request refuses a re-read", refused === "INVALID_STATE", refused);

console.log(failures === 0 ? "\\nALL OUTAGE CHECKS PASS" : `\\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
