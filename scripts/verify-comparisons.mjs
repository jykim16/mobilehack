#!/usr/bin/env node
// Verifies the Exa cross-store comparison workflow against a deployment.
// Usage: node scripts/verify-comparisons.mjs [convexUrl]
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
const { itemId } = await c.mutation(api.cart.addItem, {
  url: "https://www.amazon.com/dp/B09XS7JWHH",
  idempotencyKey: "cmp-" + runId,
});

let item;
let comparison = null;
for (let i = 0; i < 90; i++) {
  item = await c.query(api.cart.getItem, { itemId });
  comparison = item.comparison;
  if (comparison && ["completed", "empty", "failed"].includes(comparison.status)) break;
  await sleep(3000);
}
console.log("   comparison:", JSON.stringify(comparison, null, 1).slice(0, 900));

check("a comparison row exists for the item", comparison !== null);
check("the comparison terminates in a final state", comparison && ["completed", "empty", "failed"].includes(comparison.status), comparison?.status);
check("it is keyed to the submitted URL", comparison?.subjectUrl === "https://www.amazon.com/dp/B09XS7JWHH", comparison?.subjectUrl);
if (comparison?.status === "completed") {
  check("offers carry a listing price, checked time and the Exa label", comparison.offers.every((o) => typeof o.priceCents === "number" && typeof o.checkedAt === "number" && o.reportedBy === "exa"));
  check("offers are not claimed as verified by us", comparison.offers.every((o) => o.reportedBy === "exa"));
  check("offers are not used or refurbished", comparison.offers.every((o) => !/used|refurb|renew/i.test(o.condition ?? "")));
  check("no combined checkout total is invented", comparison.offers.every((o) => o.shippingCents === null || typeof o.shippingCents === "number"));
} else {
  check("the empty state says so", (comparison?.note ?? "").length > 0, comparison?.note);
}
console.log(failures === 0 ? "\nALL COMPARISON CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
