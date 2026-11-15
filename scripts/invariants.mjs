#!/usr/bin/env node
// Purchase invariants against a real deployment (local anonymous or cloud).
// Usage: node scripts/invariants.mjs [convexUrl]
//   1. defer places zero orders
//   2. double approve places exactly one order (stable orderRef)
//   3. a stale quoteVersion is rejected and places no order
//   4. another shopper cannot read or decide someone else's records
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
let url = process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url && existsSync(".env.local")) {
  url = readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim();
}
if (!url) throw new Error("Pass a Convex URL or set EXPO_PUBLIC_CONVEX_URL");
console.log("target:", url);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

async function newShopper() {
  const c = new ConvexHttpClient(url);
  const session = await c.action(api.auth.signIn, { provider: "anonymous" });
  c.setAuth(session.tokens.token);
  return c;
}

const code = (e) => (e && typeof e === "object" && "data" in e ? e.data?.code : undefined);

async function heroReady(client, runId) {
  await client.mutation(api.demo.resetDemo, {});
  const { heroUrl } = await client.mutation(api.demo.setupMyCart, {});
  const { itemId } = await client.mutation(api.cart.addItem, {
    url: heroUrl,
    idempotencyKey: "inv-" + runId,
  });
  for (let i = 0; i < 40; i++) {
    const item = await client.query(api.cart.getItem, { itemId });
    if (item.enrichmentStatus === "ready" || item.enrichmentStatus === "partial") return item;
    await sleep(1000);
  }
  throw new Error("enrichment did not finish");
}

async function requestFor(client, item, runId, tag) {
  return await client.action(api.purchases.requestPurchase, {
    itemId: item.id,
    offerId: item.offer.id,
    quantity: 1,
    reason: "invariant test " + tag,
    idempotencyKey: `inv-req-${tag}-${runId}`,
  });
}

async function ordersFor(client, requestId) {
  const all = await client.query(api.purchases.listPurchases, {});
  return all.filter((p) => p.requestId === requestId).length;
}

const alice = await newShopper();
const runId = Date.now();

// 1. defer places zero orders
let item = await heroReady(alice, runId);
await alice.mutation(api.demo.advancePrice, {});
let req = await requestFor(alice, item, runId, "defer");
const deferred = await alice.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  decision: "defer",
});
await sleep(3000);
check("defer -> outcome deferred", deferred.outcome === "deferred", deferred.outcome);
check("defer -> zero orders", (await ordersFor(alice, req.requestId)) === 0);
const afterDefer = await alice.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check("defer -> no order record on request", afterDefer.order === null && afterDefer.status === "deferred");

// 2. double approve places exactly one order
item = await heroReady(alice, runId + 1);
await alice.mutation(api.demo.advancePrice, {});
req = await requestFor(alice, item, runId + 1, "approve");
const a1 = await alice.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  decision: "approve",
});
const a2 = await alice.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  decision: "approve",
});
check("first approve -> approved", a1.outcome === "approved", a1.outcome);
check("double approve -> already_approved", a2.outcome === "already_approved", a2.outcome);
check("double approve -> same orderRef", a1.request.order.orderRef === a2.request.order.orderRef);
let placed = null;
for (let i = 0; i < 30; i++) {
  placed = await alice.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
  if (placed.order?.status === "placed") break;
  await sleep(1000);
}
check("order placed exactly once", (await ordersFor(alice, req.requestId)) === 1, "orders for request: " + (await ordersFor(alice, req.requestId)));
check("request -> ordered", placed.status === "ordered", placed.status);

// 3. stale quoteVersion is rejected, no order placed
item = await heroReady(alice, runId + 2);
await alice.mutation(api.demo.advancePrice, {});
req = await requestFor(alice, item, runId + 2, "stale");
const stale = await alice.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion - 1,
  decision: "approve",
});
await sleep(2000);
check("stale quoteVersion -> stale_quote", stale.outcome === "stale_quote", stale.outcome);
check("stale quoteVersion -> zero orders", (await ordersFor(alice, req.requestId)) === 0);
const stillPending = await alice.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check("stale quoteVersion -> request still pending", stillPending.status === "pending_approval", stillPending.status);

// 4. ownership
const mallory = await newShopper();
let blockedRead = null;
try {
  await mallory.query(api.cart.getItem, { itemId: item.id });
  blockedRead = "allowed";
} catch (e) {
  blockedRead = code(e);
}
check("other shopper cannot read the item", blockedRead === "NOT_FOUND", String(blockedRead));
let blockedDecide = null;
try {
  await mallory.mutation(api.purchases.decidePurchase, {
    requestId: req.requestId,
    quoteVersion: req.quoteVersion,
    decision: "approve",
  });
  blockedDecide = "allowed";
} catch (e) {
  blockedDecide = code(e);
}
check("other shopper cannot decide the request", blockedDecide === "NOT_FOUND", String(blockedDecide));
let anonymousBlocked = null;
try {
  await new ConvexHttpClient(url).query(api.cart.listItems, {});
  anonymousBlocked = "allowed";
} catch (e) {
  anonymousBlocked = code(e);
}
check("unauthenticated call refused", anonymousBlocked === "UNAUTHENTICATED", String(anonymousBlocked));

console.log(failures === 0 ? "\nALL INVARIANTS PASS" : `\n${failures} INVARIANT(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
