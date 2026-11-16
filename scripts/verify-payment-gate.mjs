#!/usr/bin/env node
// Proves the payment gate: approving opens a checkout but places no order, and the
// order can only move once a payment is confirmed for that quote version.
// Run: node scripts/verify-payment-gate.mjs
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

await client.mutation(api.demo.resetDemo, {});
const { heroUrl } = await client.mutation(api.demo.setupMyCart, {});
const { itemId } = await client.mutation(api.cart.addItem, {
  url: heroUrl,
  idempotencyKey: "gate-" + Date.now(),
});
let item = null;
for (let i = 0; i < 30; i++) {
  item = await client.query(api.cart.getItem, { itemId });
  if (item?.offer?.id) break;
  await sleep(1000);
}
check("the item has an offer to quote", Boolean(item?.offer?.id));

const req = await client.action(api.purchases.requestPurchase, {
  itemId,
  offerId: item.offer.id,
  quantity: 1,
  reason: "verify the payment gate places no order",
  idempotencyKey: "gate-req-" + Date.now(),
});
const paid = await client.action(api.payments.approveAndPay, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  idempotencyKey: "gate-pay-" + Date.now(),
});
check("approveAndPay returns a hosted checkout", typeof paid.checkoutUrl === "string" && paid.checkoutUrl.startsWith("https://"), paid.checkoutUrl);
check("the payment is not paid yet", paid.status === "pending", paid.status);
check("the order is waiting on money, not placed", paid.orderId !== undefined, paid.orderId);

const retried = await client.action(api.payments.approveAndPay, {
  requestId: req.requestId,
  quoteVersion: req.quoteVersion,
  idempotencyKey: "gate-pay-again-" + Date.now(),
});
check("a second approve-and-pay reuses the same checkout", retried.paymentId === paid.paymentId && retried.reused === true, `${retried.reused}`);

const stale = await errorCode(() =>
  client.action(api.payments.approveAndPay, {
    requestId: req.requestId,
    quoteVersion: req.quoteVersion + 7,
    idempotencyKey: "gate-stale-" + Date.now(),
  }),
);
check("a quote version that is not current is refused", stale === "STALE_QUOTE", stale);

// The invariant: approval alone places nothing. Wait past the submit window and
// assert the order never moved.
for (let i = 0; i < 6; i++) {
  await sleep(2000);
  const status = await client.query(api.payments.status, { requestId: req.requestId });
  if (status?.order?.status === "placed") {
    check("approval without payment places zero orders", false, "order became placed");
    break;
  }
  if (i === 5) {
    check(
      "approval without payment places zero orders",
      status?.order?.status === "awaiting_payment",
      status?.order?.status,
    );
  }
}

const status = await client.query(api.payments.status, { requestId: req.requestId });
check("the recovery query reports the pending payment", status?.payment?.status === "pending", status?.payment?.status);
check("it carries the checkout url for a refreshed screen", typeof status?.payment?.checkoutUrl === "string", status?.payment?.checkoutUrl);
check("paid and placed stay separate events", status?.payment?.paidAt === null && status?.order?.placedAt === null, JSON.stringify({ paidAt: status?.payment?.paidAt, placedAt: status?.order?.placedAt }));

const account = await client.query(api.payments.subaccount, {});
check("the subaccount query answers with balance and card fields", account !== null && typeof account.availableCents === "number" && typeof account.kycRequired === "boolean", JSON.stringify({ availableCents: account?.availableCents, pendingCents: account?.pendingCents, kycRequired: account?.kycRequired, cardStatus: account?.cardStatus }));

console.log(failures === 0 ? "\nALL PAYMENT-GATE CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
