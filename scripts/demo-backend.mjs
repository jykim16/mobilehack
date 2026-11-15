#!/usr/bin/env node
// End-to-end demo of the Convex backend through the public, authenticated API.
// Usage: node scripts/demo-backend.mjs   (reads EXPO_PUBLIC_CONVEX_URL from env or .env.local)
// Flow: anonymous sign-in -> seed second-store item -> add hero -> sections fill ->
//       set $250 all-in target -> price drop -> requestPurchase -> approve -> order -> shipment.
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFileSync, existsSync } from "node:fs";

const api = anyApi;
const DEFAULT_URL = "https://hearty-skunk-641.convex.cloud";
const fromEnvFile = () =>
  existsSync(".env.local")
    ? readFileSync(".env.local", "utf8").match(/^EXPO_PUBLIC_CONVEX_URL=(.+)$/m)?.[1]?.trim()
    : undefined;
let url =
  process.argv[2] ?? process.env.CONVEX_URL ?? process.env.EXPO_PUBLIC_CONVEX_URL ?? fromEnvFile() ?? DEFAULT_URL;
if (!url) throw new Error("Set EXPO_PUBLIC_CONVEX_URL");
const client = new ConvexHttpClient(url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const usd = (c) => (c == null ? "-" : "$" + (c / 100).toFixed(2));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const signIn = await client.action(api.auth.signIn, { provider: "anonymous" });
client.setAuth(signIn.tokens.token);
log("signed in anonymously");

await client.mutation(api.demo.resetDemo, {});
const { heroUrl, secondItemId } = await client.mutation(api.demo.setupMyCart, {});
log("second store item:", secondItemId, "| hero url", heroUrl);

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
// Give the Firecrawl offer refresh a chance to land before the price beat.
for (let i = 0; i < 30 && item.offer?.provenance?.method !== "firecrawl"; i++) {
  await sleep(2000);
  item = await client.query(api.cart.getItem, { itemId: added.itemId });
}
if (item.offer?.provenance?.method === "firecrawl") {
  log(
    `live offer from firecrawl: ${item.offer.seller}${item.offer.condition ? " (" + item.offer.condition + ")" : ""} ${usd(item.offer.priceCents)} | ${item.priceHistory.observationCount} observations`,
  );
} else {
  log("firecrawl refresh did not land in time; showing the seeded demo offer");
}
for (let i = 0; i < 45; i++) {
  item = await client.query(api.cart.getItem, { itemId: added.itemId });
  if (item.comparison?.status === "completed" || item.comparison?.status === "failed") break;
  await sleep(2000);
}
log(
  `cross-store comparison ${item.comparison?.status}: ${(item.comparison?.offers ?? []).map((o) => `${o.retailer} ${usd(o.priceCents)}`).join(", ") || "no other stores"}`,
);
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

const drop = await client.mutation(api.demo.advancePrice, { itemId: added.itemId });
log("demo control: later price observation", usd(drop.priceCents), "-> all-in", usd(drop.totalCents));
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

const sheet = await client.query(api.cart.getItem, { itemId: added.itemId });
const final = await client.query(api.purchases.getPurchaseStatus, { requestId: req.requestId });
const qs = d1.request.quote;
console.log(
  [
    "\n=== APPROVAL SHEET ===",
    `item      ${sheet.product.title}`,
    `seller    ${qs.seller}${qs.simulated ? " (simulated)" : ""}`,
    `variant   ${qs.variantLabel} · qty ${qs.quantity}`,
    `subtotal  ${usd(qs.subtotalCents)}`,
    `tax       ${usd(qs.taxCents)}`,
    `shipping  ${usd(qs.shippingCents)}`,
    `total     ${usd(qs.totalCents)}  (target ${usd(sheet.decision.targetCents)}, met ${sheet.decision.targetMet})`,
    `reason    ${d1.request.reason}`,
    `outcome   ${d1.outcome} · request ${final.status} · order ${d1.request.order?.orderRef}`,
    `tracking  ${final.shipment?.carrier ?? "-"} ${final.shipment?.trackingNumber ?? ""} (${final.shipment?.status ?? "-"}) eta ${final.shipment?.eta ?? "-"}`,
    `sections  ${sheet.sections.map((s) => `${s.section}:${s.status}${s.simulated ? "(demo)" : ""}`).join(" ")}`,
    "======================\n",
  ].join("\n"),
);
