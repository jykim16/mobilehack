#!/usr/bin/env node
// Verifies api.cart.addItemFromQuery: Exa resolves words to a product URL, the
// item lands through the normal add pipeline, and idempotencyKey dedupes.
// Run: node scripts/verify-add-by-query.mjs
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

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  (${detail})`}`);
};

const started = Date.now();
const key = "query-add-" + Date.now();
const added = await client.action(api.cart.addItemFromQuery, {
  query: "Sony WH-1000XM5 wireless noise canceling headphones",
  idempotencyKey: key,
  reason: "resolved from the cart's title field",
});
const elapsed = Date.now() - started;
console.log("   resolved:", JSON.stringify(added).slice(0, 400));
check("it resolved to a concrete product URL", /^https?:\/\//.test(added.resolvedUrl), added.resolvedUrl);
check("it reports a resolved title", typeof added.resolvedTitle === "string" && added.resolvedTitle.length > 4, added.resolvedTitle);
check("it created a cart item", Boolean(added.itemId));
check("it reports the enrichment state", typeof added.enrichmentStatus === "string", added.enrichmentStatus);
check(
  "alternatives are at most three well-formed candidates",
  Array.isArray(added.alternatives) &&
    added.alternatives.length <= 3 &&
    added.alternatives.every((a) => typeof a.title === "string" && /^https?:\/\//.test(a.url) && typeof a.retailer === "string"),
  String(added.alternatives?.length),
);
check("it took real time rather than faking a fast success", elapsed > 400, `${elapsed}ms`);

const again = await client.action(api.cart.addItemFromQuery, {
  query: "Sony WH-1000XM5 wireless noise canceling headphones",
  idempotencyKey: key,
});
check("the same idempotencyKey returns the same item", again.itemId === added.itemId, again.itemId === added.itemId);

const cart = await client.query(api.cart.listItems, {});
check("the item is in the shopper's cart", cart.some((c) => c.id === added.itemId), cart.length + " items");

const strangerUrlCheck = await client.action(api.cart.addItemFromQuery, {
  query: "Sony WH-1000XM5 wireless noise canceling headphones",
  idempotencyKey: "query-add-stranger-" + Date.now(),
});
check("another key on the same words resolves to the same product page", strangerUrlCheck.resolvedUrl === added.resolvedUrl, strangerUrlCheck.resolvedUrl);

let noMatch = null;
try {
  await client.action(api.cart.addItemFromQuery, {
    query: "   ",
    idempotencyKey: "query-add-empty-" + Date.now(),
  });
} catch (e) {
  noMatch = e?.data?.code ?? e?.cause?.data?.code ?? e?.message;
}
check("an empty query refuses with NO_MATCH", noMatch === "NO_MATCH", noMatch);

console.log(failures === 0 ? "\nALL ADD-BY-QUERY CHECKS PASS" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
