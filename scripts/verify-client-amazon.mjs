#!/usr/bin/env node
// Verifies the client-side Amazon hand-off: live quote attach, order recording, shipment sync.
// Usage: node scripts/verify-client-amazon.mjs [convexUrl]
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
const code = (e) => (e && typeof e === "object" && "data" in e ? e.data?.code : undefined);

async function shopper() {
  const c = new ConvexHttpClient(url);
  c.setAuth((await c.action(api.auth.signIn, { provider: "anonymous" })).tokens.token);
  return c;
}

const c = await shopper();
const runId = Date.now();
await c.mutation(api.demo.resetDemo, {});
const { heroUrl } = await c.mutation(api.demo.setupMyCart, {});
const { itemId } = await c.mutation(api.cart.addItem, { url: heroUrl, idempotencyKey: "ca-" + runId });
let item;
for (let i = 0; i < 40; i++) {
  item = await c.query(api.cart.getItem, { itemId });
  if (item.sections.every((s) => s.status === "ready" || s.status === "failed")) break;
  await sleep(1000);
}
await c.mutation(api.demo.advancePrice, {});
const req = await c.action(api.purchases.requestPurchase, {
  itemId,
  offerId: item.offer.id,
  quantity: 1,
  reason: "client quote test",
  idempotencyKey: "ca-req-" + runId,
});

const liveQuote = {
  retailer: "amazon",
  retailerName: "Amazon",
  seller: "Amazon.com",
  productTitle: item.product.title,
  variantLabel: "Black",
  imageUrl: item.product.imageUrl ?? null,
  quantity: 1,
  unitPriceCents: 19948,
  subtotalCents: 19948,
  taxCents: 1649,
  shippingCents: 0,
  totalCents: 21597,
  currency: "USD",
  deliveryEstimate: "FREE Prime delivery Tomorrow, Nov 16",
  returnSummary: "Free returns until Jan 31, 2027",
  quotedAt: Date.now(),
  simulated: false,
};
const attached = await c.mutation(api.purchases.attachClientQuote, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  quote: liveQuote,
});
check("client quote applied", attached.quoteVersion === req.quoteVersion + 1, JSON.stringify(attached.quoteVersion));
check("live quote replaces the simulated one", attached.quote.totalCents === 21597 && attached.quote.simulated === false && attached.quote.deliveryEstimate.startsWith("FREE Prime"));
const stamped = await c.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check("request carries the client quote", stamped.quote.totalCents === 21597 && stamped.quoteVersion === attached.quoteVersion);

let stale = null;
try {
  await c.mutation(api.purchases.attachClientQuote, {
    requestId: req.requestId,
    quoteVersion: req.quoteVersion,
    quote: liveQuote,
  });
  stale = "allowed";
} catch (e) {
  stale = code(e);
}
check("stale quoteVersion refused", stale === "STALE_QUOTE", String(stale));

const approved = await c.mutation(api.purchases.decidePurchase, {
  requestId: req.requestId,
  quoteVersion: stamped.quoteVersion,
  decision: "approve",
});
const orderRef = approved.request.order.orderRef;
const orderId = approved.request.order.orderId;

await sleep(8000);
const afterApprove = await c.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check(
  "a live-quoted approval waits for the device instead of the simulated adapter",
  afterApprove.order.status === "awaiting_client" && afterApprove.order.retailerOrderId === null,
  afterApprove.order.status + " / " + String(afterApprove.order.retailerOrderId),
);


const now = Date.now();
const placed = await c.mutation(api.orders.recordClientPlacement, {
  orderRef,
  retailerOrderId: "114-3372047-8398581",
  placedAt: now,
  shipment: {
    status: "ordered",
    carrier: "Amazon Logistics",
    trackingNumber: "TBA307211948000",
    trackingUrl: "https://track.amazon.com/tracking/TBA307211948000",
    eta: "2026-11-17",
    events: [{ status: "ordered", description: "Order received", location: null, occurredAt: now }],
    updatedAt: now,
    simulated: false,
  },
});
const replay = await c.mutation(api.orders.recordClientPlacement, {
  orderRef,
  retailerOrderId: "114-3372047-8398581",
  placedAt: now,
});
check("placement recorded", placed.status === "placed" && placed.retailerOrderId === "114-3372047-8398581", JSON.stringify(placed));
check("repeat placement is idempotent", replay.status === "already_recorded", replay.status);

const synced = await c.mutation(api.orders.syncClientShipment, {
  orderRef,
  retailerOrderId: "114-3372047-8398581",
  shipment: {
    status: "shipped",
    carrier: "Amazon Logistics",
    trackingNumber: "TBA307211948000",
    trackingUrl: "https://track.amazon.com/tracking/TBA307211948000",
    eta: "2026-11-17",
    events: [
      { status: "ordered", description: "Order received", location: null, occurredAt: now - 7200_000 },
      { status: "shipped", description: "Package arrived at carrier facility", location: "Kent, WA", occurredAt: now - 3600_000 },
    ],
    updatedAt: now,
    simulated: false,
  },
});
const after = await c.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check("shipment synced from the device", synced.updated === true, JSON.stringify(synced));
check(
  "scraped status, carrier, tracking and events land on the request",
  after.shipment.status === "shipped" &&
    after.shipment.carrier === "Amazon Logistics" &&
    after.shipment.trackingNumber === "TBA307211948000" &&
    after.shipment.events.length === 2 &&
    after.shipment.simulated === false,
  (after.shipment.events ?? []).map((e) => e.description).join(" -> "),
);
check("request is ordered and the order is placed", after.status === "ordered" && after.order.status === "placed");

await sleep(12000);
const later = await c.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check(
  "the simulated carrier job cannot overwrite live shipment data",
  later.shipment.status === "shipped" && later.shipment.events.length === 2,
  later.shipment.status + "/" + later.shipment.events.length,
);

// Drive the simulated scan job by hand: the atomic guard inside applyShipment must refuse it.
const { execFileSync } = await import("node:child_process");
let ranSimulatedScan = false;
try {
  execFileSync("npx", ["convex", "run", "orders:syncShipment", JSON.stringify({ orderId: afterApprove.order.orderId, polls: 0 })], {
    stdio: "ignore",
    timeout: 90_000,
  });
  ranSimulatedScan = true;
} catch (e) {
  console.log("   (could not run the simulated job here:", String(e).slice(0, 120) + ")");
}
const postScan = await c.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
check(
  ranSimulatedScan ? "simulated scan refused by applyShipment" : "live shipment untouched after a simulated poll",
  postScan.shipment.status === "shipped" && postScan.shipment.events.length === 2 && postScan.shipment.simulated === false,
  postScan.shipment.status + "/" + postScan.shipment.events.length + "/simulated=" + postScan.shipment.simulated,
);

const purchases = await c.query(api.purchases.listPurchases, {});
const listed = purchases.find((p) => p.orderRef === orderRef);
check("Purchases tab shows the live order", listed?.retailerOrderId === "114-3372047-8398581" && listed?.shipment?.status === "shipped");

// Approval bypass: a quote that went stale between approval and submission sends the
// order back for approval, and the device must not be able to place it.
const gItemId = (await c.mutation(api.cart.addItem, { url: heroUrl, idempotencyKey: "ca-g-" + runId })).itemId;
let gItem;
for (let i = 0; i < 40; i++) {
  gItem = await c.query(api.cart.getItem, { itemId: gItemId });
  if (gItem.sections.every((s) => s.status === "ready" || s.status === "failed")) break;
  await sleep(1000);
}
const gReq = await c.action(api.purchases.requestPurchase, {
  itemId: gItemId,
  offerId: gItem.offer.id,
  quantity: 1,
  reason: "requote guard",
  idempotencyKey: "ca-greq-" + runId,
});
await c.mutation(api.demo.advancePrice, {});
const gApprove = await c.mutation(api.purchases.decidePurchase, {
  requestId: gReq.requestId,
  quoteVersion: gReq.quoteVersion,
  decision: "approve",
});
await sleep(6000);
const gStatus = await c.query(api.purchases.getPurchaseStatus, { requestId: gReq.requestId });
check(
  "a stale approved quote sends the order back for approval",
  gStatus.order.status === "requote_required" && gStatus.status === "pending_approval",
  gStatus.order.status + " / request " + gStatus.status,
);
let refused = null;
try {
  await c.mutation(api.orders.recordClientPlacement, {
    orderRef: gApprove.request.order.orderRef,
    retailerOrderId: "114-0000000-0000001",
    placedAt: Date.now(),
  });
  refused = "allowed";
} catch (e) {
  refused = code(e);
}
check("placement refused until the fresh quote is approved", refused === "INVALID_STATE", String(refused));

const mallory = await shopper();
const attempt = async (fn) => {
  try {
    await fn();
    return "allowed";
  } catch (e) {
    return code(e);
  }
};
check(
  "another shopper cannot attach a quote",
  (await attempt(() => mallory.mutation(api.purchases.attachClientQuote, { requestId: req.requestId, quoteVersion: 1, quote: liveQuote }))) === "NOT_FOUND",
);
check(
  "another shopper cannot record a placement",
  (await attempt(() => mallory.mutation(api.orders.recordClientPlacement, { orderRef, retailerOrderId: "114-0000000-0000000", placedAt: now }))) === "NOT_FOUND",
);
check(
  "another shopper cannot sync a shipment",
  (await attempt(() =>
    mallory.mutation(api.orders.syncClientShipment, {
      orderRef,
      retailerOrderId: "114-3372047-8398581",
      shipment: { status: "delivered", carrier: null, trackingNumber: null, trackingUrl: null, eta: null, events: [], updatedAt: now, simulated: false },
    }),
  )) === "NOT_FOUND",
);

console.log(failures === 0 ? "\nALL CLIENT-AMAZON CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
