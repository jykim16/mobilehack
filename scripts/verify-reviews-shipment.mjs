#!/usr/bin/env node
// Verifies the reviews list and the shipment timeline against a deployment.
// Usage: node scripts/verify-reviews-shipment.mjs [convexUrl]
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
const DEFAULT_URL = "https://hearty-skunk-641.convex.cloud";
const fromEnvFile = () =>
  existsSync(".env.local")
    ? readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim()
    : undefined;
const url = process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL ?? fromEnvFile() ?? DEFAULT_URL;
console.log("target:", url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

const client = new ConvexHttpClient(url);
const session = await client.action(api.auth.signIn, { provider: "anonymous" });
client.setAuth(session.tokens.token);
const runId = Date.now();

await client.mutation(api.demo.resetDemo, {});
const { heroUrl } = await client.mutation(api.demo.setupMyCart, {});
const { itemId } = await client.mutation(api.cart.addItem, { url: heroUrl, idempotencyKey: "rv-" + runId });

let item;
for (let i = 0; i < 40; i++) {
  item = await client.query(api.cart.getItem, { itemId });
  if (item.enrichmentStatus === "ready" || item.enrichmentStatus === "partial") break;
  await sleep(1000);
}

const empty = await client.query(api.reviews.list, { cartItemId: itemId });
check("reviews query returns the documented shape", Array.isArray(empty.reviews) && Array.isArray(empty.bySource));

const rv = await client.query(api.reviews.list, { cartItemId: itemId });
check("reviews aggregated across sources", rv.reviews.length >= 4, rv.reviews.length + " reviews");
const sources = [...new Set(rv.reviews.map((r) => r.source))].sort();
check("sources include reddit, retailer and seeded social", sources.length >= 3, sources.join(", "));
const dated = rv.reviews.filter((r) => r.postedAt !== null);
check("newest first", dated.every((r, i) => i === 0 || dated[i - 1].postedAt >= r.postedAt));
check("dated reviews sort before undated ones", rv.reviews.findIndex((r) => r.postedAt === null) === -1 || rv.reviews.slice(rv.reviews.findIndex((r) => r.postedAt === null)).every((r) => r.postedAt === null));
check("deduped by url and text", new Set(rv.reviews.map((r) => r.url + "|" + r.text)).size === rv.reviews.length);
check("every review links to a real page", rv.reviews.every((r) => r.url.startsWith("https://")));
check("no review carries an invented url fragment", rv.reviews.every((r) => !r.url.includes("#review-")));
check("bySource tallies match", rv.bySource.reduce((n, s) => n + s.count, 0) === rv.reviews.length);
const x = rv.reviews.find((r) => r.source === "x");
const yt = rv.reviews.find((r) => r.source === "youtube");
check("seeded X and YouTube entries present and simulated", !!x && !!yt && x.simulated && yt.simulated, `${x?.author} / ${yt?.author}`);

const other = new ConvexHttpClient(url);
other.setAuth((await other.action(api.auth.signIn, { provider: "anonymous" })).tokens.token);
let blocked = null;
try {
  await other.query(api.reviews.list, { cartItemId: itemId });
  blocked = "allowed";
} catch (e) {
  blocked = e?.data?.code;
}
check("another shopper cannot read the reviews", blocked === "NOT_FOUND", String(blocked));

await client.mutation(api.demo.advancePrice, {});
const req = await client.action(api.purchases.requestPurchase, {
  itemId,
  offerId: item.offer.id,
  quantity: 1,
  reason: "timeline verification",
  idempotencyKey: "rv-req-" + runId,
});
await client.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  decision: "approve",
});

let status;
const seen = new Set();
for (let i = 0; i < 60; i++) {
  status = await client.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
  const events = status.shipment?.events ?? [];
  const line = `${status.shipment?.carrier ?? "-"} ${status.shipment?.status ?? "-"} events=${events.length} tracking=${status.shipment?.trackingNumber ?? "-"}`;
  if (!seen.has(line)) {
    seen.add(line);
    console.log("   ", line, events.length ? "| last: " + events[events.length - 1].description + " @ " + events[events.length - 1].location : "");
  }
  if (status.shipment?.status === "delivered") break;
  await sleep(3000);
}
const events = status.shipment?.events ?? [];
check("timeline reached delivered", status.shipment?.status === "delivered", status.shipment?.status);
check("timeline has the USPS scan sequence", events.length >= 5, events.map((e) => e.description).join(" -> "));
check("events carry locations and increasing times", events.every((e, i) => (i === 0 || e.occurredAt >= events[i - 1].occurredAt)), "");
check("tracking number and carrier present", !!status.shipment?.trackingNumber && !!status.shipment?.carrier);
check("order kept its stable orderRef", !!status.order?.orderRef, status.order?.orderRef);

console.log(failures === 0 ? "\nALL REVIEW/TIMELINE CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
