#!/usr/bin/env node
// Verifies api.cart.removeItem: ownership, the pending-approval expiry, and the
// refusal once a request is approved. Run: node scripts/verify-remove-item.mjs
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  (${detail})`}`);
};

async function signIn() {
  const client = new ConvexHttpClient(url);
  const s = await client.action(api.auth.signIn, { provider: "anonymous" });
  client.setAuth(s.tokens.token);
  return client;
}

async function errorCode(fn) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e?.data?.code ?? e?.cause?.data?.code ?? e?.message ?? "UNKNOWN";
  }
}

async function offerFor(client, itemId) {
  for (let i = 0; i < 30; i++) {
    const item = await client.query(api.cart.getItem, { itemId });
    if (item?.offer?.id) return item;
    await sleep(1000);
  }
  return null;
}

const shopper = await signIn();
const stranger = await signIn();

await shopper.mutation(api.demo.resetDemo, {});
const { heroUrl, secondItemId } = await shopper.mutation(api.demo.setupMyCart, {});

const foreign = await errorCode(() => stranger.mutation(api.cart.removeItem, { cartItemId: secondItemId }));
check("another shopper cannot remove the item", foreign === "NOT_FOUND", foreign);

const second = await offerFor(shopper, secondItemId);
check("the seeded second-store item has an offer", Boolean(second?.offer?.id));
const pendingReq = await shopper.action(api.purchases.requestPurchase, {
  itemId: secondItemId,
  offerId: second.offer.id,
  quantity: 1,
  reason: "verify removeItem expiring a pending request",
  idempotencyKey: "rm-pending-" + Date.now(),
});
const removed = await shopper.mutation(api.cart.removeItem, { cartItemId: secondItemId });
check("removeItem reports what it removed", removed?.removed === true && typeof removed.title === "string" && removed.title.length > 0, removed?.title);
const expired = await shopper.query(api.purchases.getPurchaseStatus, { requestId: pendingReq.requestId });
check("the pending request expired instead of dangling", expired.status === "expired", expired.status);
const gone = await errorCode(() => shopper.query(api.cart.getItem, { itemId: secondItemId }));
check("the item is gone from the cart", gone === "NOT_FOUND", gone);

const hero = await shopper.mutation(api.cart.addItem, {
  url: heroUrl,
  idempotencyKey: "rm-hero-" + Date.now(),
});
const heroItem = await offerFor(shopper, hero.itemId);
check("the hero item has an offer to quote", Boolean(heroItem?.offer?.id));
const approvedReq = await shopper.action(api.purchases.requestPurchase, {
  itemId: hero.itemId,
  offerId: heroItem.offer.id,
  quantity: 1,
  reason: "verify removeItem refusing mid-checkout",
  idempotencyKey: "rm-approved-" + Date.now(),
});
const decision = await shopper.mutation(api.purchases.decidePurchase, {
  requestId: approvedReq.requestId,
  quoteVersion: approvedReq.quoteVersion,
  decision: "approve",
});
check("the request was approved", decision.outcome === "approved", decision.outcome);
const refused = await errorCode(() => shopper.mutation(api.cart.removeItem, { cartItemId: hero.itemId }));
check("an approved request refuses removal", refused === "INVALID_STATE", refused);
const stillThere = await errorCode(() => shopper.query(api.cart.getItem, { itemId: hero.itemId }));
check("the item survives the refusal", stillThere === null, stillThere);

console.log(failures === 0 ? "\nALL REMOVE-ITEM CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
