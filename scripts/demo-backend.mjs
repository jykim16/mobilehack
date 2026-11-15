#!/usr/bin/env node
// End-to-end demo of the Convex backend through the public, authenticated API.
// Usage: node scripts/demo-backend.mjs   (reads EXPO_PUBLIC_CONVEX_URL from env or .env.local)
// Flow: anonymous sign-in -> seed second-store item -> add hero -> sections fill ->
//       set $250 all-in target -> price drop -> requestPurchase -> approve -> order -> shipment.
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
let url = process.env.EXPO_PUBLIC_CONVEX_URL;
if (!url && existsSync(".env.local")) {
  url = readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim();
}
if (!url) throw new Error("Set EXPO_PUBLIC_CONVEX_URL");
const client = new ConvexHttpClient(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (c) => (c == null ? "-" : "$" + (c / 100).toFixed(2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const signIn = await client.action(api.auth.signIn, { provider: "anonymous" });
client.setAuth(signIn.tokens.token);
log("signed in anonymously");

await client.mutation(api.demo.resetDemo, {});
const { heroUrl } = await client.mutation(api.demo.setupMyCart, {});
log("seeded Best Buy AirFly Pro; hero url", heroUrl);

const runId = Date.now();
const added = await client.mutation(api.cart.addItem, {
  url: heroUrl,
  reason: "Muse: noise-canceling headphones for long flights",
  idempotencyKey: "demo-hero-" + runId,
});
const again = await client.mutation(api.cart.addItem, { url: heroUrl, idempotencyKey: "demo-hero-" + runId });
log("addItem ->", added.itemId, added.enrichmentStatus, "| retry deduplicated:", again.deduplicated);

let item;
const seen = new Set();
for (let i = 0; i < 40; i++) {
  item = await client.query(api.cart.getItem, { itemId: added.itemId });
  for (const s of item.sections) {
    if (s.status === "ready" && !seen.has(s.section)) {
      seen.add(s.section);
      log(`section ${s.section} ready${s.simulated ? " (demo data)" : ""}: ${s.summary}`);
    }
  }
  if (item.enrichmentStatus === "ready" || item.enrichmentStatus === "partial") break;
  await sleep(1000);
}
const newCriterion = item.sections.find((s) => s.section === "categoryGuidance").highlights.find((h) => h.tone === "new_criterion");
log("criterion you didn't ask about:", newCriterion?.label);
log("enrichment:", item.enrichmentStatus, "| all-in now", usd(item.price.totalCents));

await client.mutation(api.cart.updateDecision, {
  itemId: added.itemId,
  priorities: ["Comfort on long flights", "Wired listening and audio quality"],
  targetCents: 25000,
  targetAppliesTo: "all_in",
});
let cart = await client.query(api.cart.listItems, {});
log("cart:", cart.map((c) => `${c.offer.retailerName}: ${c.product.title.slice(0, 30)} ${usd(c.price.totalCents)}`).join(" | "));
log("target $250 all-in met?", cart.find((c) => c.id === added.itemId).decision.targetMet);

const drop = await client.mutation(api.demo.advancePrice, {});
log("demo control: later price observation", usd(drop.priceCents));
item = await client.query(api.cart.getItem, { itemId: added.itemId });
log("all-in now", usd(item.price.totalCents), "| target met?", item.decision.targetMet);

const req = await client.action(api.purchases.requestPurchase, {
  itemId: added.itemId,
  offerId: item.offer.id,
  quantity: 1,
  reason: "Under your $250 all-in target after the price drop",
  idempotencyKey: "demo-req-" + runId,
});
const q = req.quote;
log(`requestPurchase -> ${req.status} v${req.quoteVersion}: ${q.variantLabel}, ${q.seller}, qty ${q.quantity}, subtotal ${usd(q.subtotalCents)} + tax ${usd(q.taxCents)} + ship ${usd(q.shippingCents)} = ${usd(q.totalCents)}${q.simulated ? " (simulated)" : ""}`);
const pending = await client.query(api.purchases.listPendingApprovals, {});
log("pending approvals:", pending.length);

const d1 = await client.mutation(api.purchases.decidePurchase, { requestId: req.requestId, quoteVersion: req.quoteVersion, decision: "approve" });
const d2 = await client.mutation(api.purchases.decidePurchase, { requestId: req.requestId, quoteVersion: req.quoteVersion, decision: "approve" });
log("approve ->", d1.outcome, "| approve again ->", d2.outcome, "| orderRef", d1.request.order?.orderRef);

for (let i = 0; i < 40; i++) {
  const st = await client.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
  const line = `request ${st.status} | order ${st.order?.status} ${st.order?.retailerOrderId ?? ""} | shipment ${st.shipment?.status ?? "-"} ${st.shipment?.trackingNumber ?? ""} eta ${st.shipment?.eta ?? "-"}`;
  if (!seen.has(line)) { seen.add(line); log(line); }
  if (st.shipment?.status === "shipped") break;
  await sleep(2000);
}
const purchases = await client.query(api.purchases.listPurchases, {});
log("purchases tab:", purchases.map((p) => `${p.orderRef} ${usd(p.quote.totalCents)} ${p.shipment?.status} via ${p.shipment?.carrier}`).join(" | "));
