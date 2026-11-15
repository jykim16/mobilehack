#!/usr/bin/env node
// End-to-end check of the Cart MCP endpoint: OAuth (DCR + PKCE) or a connection token, then every tool.
// Usage: MCP_TOKEN=<cart_ct_...> node scripts/mcp-smoke.mjs <site-url>          # bearer path
//        node scripts/mcp-smoke.mjs <site-url> --login <pairing code>          # OAuth path
//   MCP_TOKEN=cart_ct_... node scripts/mcp-smoke.mjs <site-url>   # skip OAuth, use a connection token
import { createHash, randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const site = (args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) ?? process.env.CONVEX_SITE_URL ?? process.env.EXPO_PUBLIC_CONVEX_SITE_URL ?? "").replace(/\/$/, "");
if (!site) throw new Error("Pass the Convex site URL, e.g. https://<deployment>.convex.site");
const login = flag("--login", null); // a pairing code from the Cart app
const productUrl = flag("--url", "https://www.amazon.com/dp/B09XS7JWHH");

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
let failures = 0;
const check = (ok, label, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  " + detail : ""}`);
  if (!ok) failures++;
};

async function oauthToken() {
  const unauth = await fetch(`${site}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }) });
  const challenge = unauth.headers.get("www-authenticate") ?? "";
  check(unauth.status === 401 && challenge.includes("resource_metadata"), "unauthenticated /mcp returns 401 with resource_metadata", challenge);

  const prmUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1] ?? `${site}/.well-known/oauth-protected-resource`;
  const prm = await (await fetch(prmUrl)).json();
  check(prm.resource === `${site}/mcp`, "protected resource metadata", prm.resource);
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  check(as.code_challenge_methods_supported?.includes("S256") && !!as.registration_endpoint, "authorization server metadata", as.issuer);

  const redirectUri = "https://example.com/callback";
  const reg = await fetch(as.registration_endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Cart smoke test", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }) });
  const client = await reg.json();
  check(reg.status === 201 && !!client.client_id, "dynamic client registration");

  const verifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash("sha256").update(verifier).digest());
  const authParams = { response_type: "code", client_id: client.client_id, redirect_uri: redirectUri, code_challenge: codeChallenge, code_challenge_method: "S256", state: "xyz", resource: prm.resource, scope: "cart" };
  const page = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(authParams)}`);
  check(page.status === 200 && (await page.text()).includes("Connect Cart"), "authorize page renders");

  const consent = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...authParams, code: login }) });
  const location = new URL(consent.headers.get("location") ?? "about:blank");
  const code = location.searchParams.get("code");
  check(consent.status === 302 && !!code && location.searchParams.get("state") === "xyz", "sign-in redirects with code and state");

  const tok = await fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: verifier }) });
  const tokens = await tok.json();
  check(tok.status === 200 && tokens.token_type === "Bearer" && !!tokens.refresh_token, "token exchange with PKCE");

  const refreshed = await fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }) });
  const next = await refreshed.json();
  check(refreshed.status === 200 && !!next.access_token, "refresh token rotation");

  const oldRefresh = await fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }) });
  check(oldRefresh.status === 400, "a used refresh token is refused");

  const bogus = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...authParams, code: "ZZZZZZ" }) });
  check(bogus.status === 400, "an unknown pairing code is refused");

  if (process.env.MCP_ALLOW_CODE_REUSE === "1") {
    const consent2 = await fetch(as.authorization_endpoint, { method: "POST", redirect: "manual", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...authParams, code: login }) });
    const code2 = new URL(consent2.headers.get("location")).searchParams.get("code");
    const badPkce = await fetch(as.token_endpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id: client.client_id, redirect_uri: redirectUri, code_verifier: "wrong" }) });
    check(badPkce.status === 400, "wrong PKCE verifier is rejected (and burns the code)");
  } else {
    console.log("SKIP  wrong PKCE verifier: a single-use pairing code cannot be spent twice");
  }

  return next.access_token;
}

if (!process.env.MCP_TOKEN && !login) {
  console.error("Pass MCP_TOKEN=<cart_ct_...> for the bearer path, or --login <pairing code> for the OAuth path.");
  console.error("Mint one: npx convex run mcp/connection:mintPairingCodeInternal '{\"shopperId\":\"<id>\"}'");
  process.exit(1);
}
const token = process.env.MCP_TOKEN || (await oauthToken());
let nextId = 1;
async function rpc(method, params) {
  const res = await fetch(`${site}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  return { status: res.status, body: await res.json() };
}
async function call(name, args) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result ?? {};
  console.log(`      ${name} -> ${JSON.stringify(result.structuredContent ?? result.content?.[0]?.text).slice(0, 400)}`);
  return result;
}

const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
check(init.status === 200 && init.body.result?.serverInfo?.name === "cart", "initialize", init.body.result?.protocolVersion);
const listed = await rpc("tools/list", {});
const names = (listed.body.result?.tools ?? []).map((t) => t.name);
check(["add_cart_item", "list_cart_items", "get_cart_item", "request_purchase", "get_purchase_status"].every((n) => names.includes(n)), "tools/list", names.join(", "));

const added = await call("add_cart_item", { url: productUrl, reason: "Smoke test: long-flight headphones", idempotencyKey: `smoke-${Date.now()}` });
const itemId = added.structuredContent?.itemId;
check(!added.isError && !!itemId, "add_cart_item");
const list = await call("list_cart_items", {});
check(!list.isError && Array.isArray(list.structuredContent?.items), "list_cart_items");
let item;
for (let attempt = 0; attempt < 15; attempt++) {
  item = await call("get_cart_item", { itemId });
  const ready = (item.structuredContent?.sections ?? []).filter((s) => s.status === "ready");
  if (ready.length >= 3) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const sections = item.structuredContent?.sections ?? [];
const withLinks = sections.filter((s) => (s.sources ?? []).some((src) => /^https?:/.test(src.url)));
check(withLinks.length > 0, "evidence sections carry source links", `${sections.filter((s) => s.status === "ready").length}/5 ready, ${withLinks.length} with links`);
check(item.structuredContent?.price?.totalCents > 0, "all-in price is quoted", item.structuredContent?.price?.totalCents);
check(!item.isError && item.structuredContent?.itemId === itemId, "get_cart_item");
const missing = await call("get_cart_item", { itemId: "does_not_exist" });
check(missing.isError === true, "get_cart_item rejects an unknown item");
const req = await call("request_purchase", { itemId, quantity: 1, reason: "Smoke test: price hit the target" });
const requestId = req.structuredContent?.requestId;
check(!req.isError && !!requestId && /approv/i.test(req.structuredContent?.status ?? ""), "request_purchase returns pending approval");
const status = await call("get_purchase_status", { requestId });
check(!status.isError && status.structuredContent?.requestId === requestId, "get_purchase_status");

let removed = null;
if (names.includes("remove_cart_item")) {
  removed = await call("remove_cart_item", { itemId });
  check(!removed.isError && removed.structuredContent?.removed === true && !!removed.structuredContent?.title, "remove_cart_item returns what it removed");
  const afterRemove = await call("get_cart_item", { itemId });
  check(afterRemove.isError === true, "the removed item is gone");
  const expired = await call("get_purchase_status", { requestId });
  check(expired.structuredContent?.status === "expired", "removing the item expired its pending request", expired.structuredContent?.status);
  const again = await call("remove_cart_item", { itemId });
  check(again.isError === true, "removing it twice refuses");
} else {
  console.log("SKIP  remove_cart_item: this deployment does not serve it yet");
}

const leaked = JSON.stringify([added, list, item, req, status, removed]).match(/"(payment\w*|card\w*|billing\w*|shippingAddress|shippingTo|address\w*|postalCode|phone\w*)"\s*:/i);
check(!leaked, "no payment or shipping fields in tool output", leaked?.[0]);

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
