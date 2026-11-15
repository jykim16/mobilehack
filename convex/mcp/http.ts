import type { HttpRouter } from "convex/server";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { httpAction, type ActionCtx } from "../_generated/server";
import { hashToken } from "../lib/tokens";
import { demoLoginShopperId } from "./backend";
import { pkceChallenge, randomToken } from "./crypto";
import { ACCESS_TOKEN_TTL_MS } from "./store";
import { backendMessage, callTool, redact, ToolInputError, TOOLS } from "./tools";

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SCOPE = "cart";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
};

/** Public HTTPS origin clients reach, e.g. https://<deployment>.convex.site. */
function siteUrl(): string {
  return (process.env.MCP_PUBLIC_URL ?? process.env.CONVEX_SITE_URL ?? "").replace(/\/$/, "");
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS_HEADERS, ...headers },
  });
}

function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

function protectedResourceMetadata() {
  const site = siteUrl();
  return {
    resource: `${site}/mcp`,
    authorization_servers: [site],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Cart",
  };
}

function authorizationServerMetadata() {
  const site = siteUrl();
  return {
    issuer: site,
    authorization_endpoint: `${site}/oauth/authorize`,
    token_endpoint: `${site}/oauth/token`,
    registration_endpoint: `${site}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
  };
}

async function readParams(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body: unknown = await req.json().catch(() => null);
    const out: Record<string, string> = {};
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) if (typeof v === "string") out[k] = v;
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(await req.text()));
}

async function authenticate(ctx: ActionCtx, req: Request): Promise<Id<"users"> | null> {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "");
  if (!match) return null;
  const resolved = await ctx.runQuery(internal.mcp.store.resolveAccessToken, {
    tokenHash: await hashToken(match[1].trim()),
    now: Date.now(),
  });
  return resolved?.shopperId ?? null;
}

type JsonRpcMessage = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };

async function handleRpc(ctx: ActionCtx, shopperId: Id<"users">, msg: JsonRpcMessage) {
  const id = msg.id ?? null;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }
  const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Record<string, unknown>;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });

  switch (msg.method) {
    case "initialize": {
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return result({
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "cart", title: "Cart", version: "0.1.0" },
        instructions:
          "Cart is the shopper's universal shopping cart. Save offers with add_cart_item, read decision context and evidence with get_cart_item, and ask for approval with request_purchase. Only the shopper approves purchases, in the Cart app; after request_purchase tell them to open Cart and then check get_purchase_status.",
      });
    }
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: TOOLS });
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = (params.arguments && typeof params.arguments === "object" ? params.arguments : {}) as Record<string, unknown>;
      try {
        const output = redact(await callTool(ctx, shopperId, name, args)) as Record<string, unknown>;
        return result({ content: [{ type: "text", text: JSON.stringify(output, null, 2) }], structuredContent: output, isError: false });
      } catch (err) {
        const known = err instanceof ToolInputError || (err instanceof Error && err.name === "ConvexError");
        if (!known) console.error("MCP tool failed", name, err);
        return result({ content: [{ type: "text", text: known ? err.message : backendMessage(err) }], isError: true });
      }
    }
    default:
      if (msg.id === undefined) return null;
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }
}

const mcpPost = httpAction(async (ctx, req) => {
  const shopperId = await authenticate(ctx, req);
  if (!shopperId) {
    return json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized: connect your Cart account" } }, 401, {
      "WWW-Authenticate": `Bearer resource_metadata="${siteUrl()}/.well-known/oauth-protected-resource", scope="${SCOPE}"`,
    });
  }
  const body: unknown = await req.json().catch(() => undefined);
  if (body === undefined) return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);

  if (Array.isArray(body)) {
    const responses = [];
    for (const msg of body) {
      const response = await handleRpc(ctx, shopperId, msg as JsonRpcMessage);
      if (response && (msg as JsonRpcMessage).id !== undefined) responses.push(response);
    }
    return responses.length ? json(responses) : new Response(null, { status: 202, headers: CORS_HEADERS });
  }
  const msg = body as JsonRpcMessage;
  const response = await handleRpc(ctx, shopperId, msg);
  if (msg.id === undefined || response === null) return new Response(null, { status: 202, headers: CORS_HEADERS });
  return json(response);
});

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function htmlPage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:-apple-system,system-ui,sans-serif;background:#f6f5f2;color:#1c1b19;display:flex;justify-content:center;padding:48px 16px;margin:0}
.card{background:#fff;border-radius:16px;padding:28px;max-width:380px;width:100%;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 8px}p{color:#5b5953;line-height:1.45}label{display:block;font-size:14px;margin:18px 0 6px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #d6d3cc;border-radius:10px;font-size:16px;text-transform:uppercase}
button{margin-top:20px;width:100%;padding:14px;border:0;border-radius:10px;background:#1c1b19;color:#fff;font-size:16px;font-weight:600}
ul{padding-left:18px;color:#5b5953;line-height:1.6}.note{font-size:12px;color:#8a877f;margin-top:16px}</style></head>
<body><div class="card">${body}</div></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );
}

type AuthorizeRequest = { clientId: string; clientName: string | null; redirectUri: string; state: string | null; codeChallenge: string; resource: string | null };

async function validateAuthorize(ctx: ActionCtx, p: Record<string, string>): Promise<AuthorizeRequest | Response> {
  const client = p.client_id ? await ctx.runQuery(internal.mcp.store.getClient, { clientId: p.client_id }) : null;
  if (!client) return htmlPage("Unknown app", "<p>This app is not registered with Cart. Remove the connector and add it again.</p>", 400);
  if (!p.redirect_uri || !client.redirectUris.includes(p.redirect_uri)) {
    return htmlPage("Invalid redirect", "<p>The redirect URI does not match the registered app.</p>", 400);
  }
  const redirectError = (error: string, description: string) => {
    const url = new URL(p.redirect_uri);
    url.searchParams.set("error", error);
    url.searchParams.set("error_description", description);
    if (p.state) url.searchParams.set("state", p.state);
    url.searchParams.set("iss", siteUrl());
    return Response.redirect(url.toString(), 302);
  };
  if (p.response_type !== "code") return redirectError("unsupported_response_type", "Only response_type=code is supported");
  if (!p.code_challenge || p.code_challenge_method !== "S256") return redirectError("invalid_request", "PKCE with S256 is required");
  return {
    clientId: client.clientId,
    clientName: client.clientName,
    redirectUri: p.redirect_uri,
    state: p.state ?? null,
    codeChallenge: p.code_challenge,
    resource: p.resource ?? null,
  };
}

const authorizeGet = httpAction(async (ctx, req) => {
  const params = Object.fromEntries(new URL(req.url).searchParams);
  const valid = await validateAuthorize(ctx, params);
  if (valid instanceof Response) return valid;
  const hidden = Object.entries(params)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("");
  const appName = escapeHtml(valid.clientName ?? "An AI agent");
  return htmlPage(
    "Connect Cart",
    `<h1>Connect Cart</h1><p><b>${appName}</b> wants to use your Cart.</p>
<ul><li>Save items and read their decision context</li><li>Ask you to approve purchases</li></ul>
<p>It cannot approve purchases, and it never sees payment or shipping details. You approve every purchase in the Cart app.</p>
<form method="post" action="/oauth/authorize">${hidden}
<label for="code">Pairing code</label><input id="code" name="code" placeholder="ABC234" autocapitalize="characters" autocomplete="one-time-code" required>
<button type="submit">Allow and connect</button></form>
<p class="note">Open Cart → Connect an agent to get a pairing code.</p>`,
  );
});

const authorizePost = httpAction(async (ctx, req) => {
  const params = await readParams(req);
  const valid = await validateAuthorize(ctx, params);
  if (valid instanceof Response) return valid;
  const entered = (params.code ?? "").trim();
  let shopperId: Id<"users"> | null = entered ? await ctx.runMutation(internal.mcp.store.consumePairingCode, { code: entered }) : null;
  if (!shopperId && entered) shopperId = await demoLoginShopperId(ctx, entered);
  if (!shopperId) {
    return htmlPage("Code not recognized", "<p>That pairing code is invalid or expired. Get a new one in the Cart app and try again.</p>", 400);
  }
  const code = randomToken("cart_code_");
  await ctx.runMutation(internal.mcp.store.createAuthCode, {
    codeHash: await hashToken(code),
    clientId: valid.clientId,
    shopperId,
    redirectUri: valid.redirectUri,
    codeChallenge: valid.codeChallenge,
    resource: valid.resource ?? undefined,
    scope: SCOPE,
  });
  const url = new URL(valid.redirectUri);
  url.searchParams.set("code", code);
  if (valid.state) url.searchParams.set("state", valid.state);
  url.searchParams.set("iss", siteUrl());
  return new Response(null, { status: 302, headers: { Location: url.toString() } });
});

const register = httpAction(async (ctx, req) => {
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return oauthError("invalid_client_metadata", "Body must be JSON");
  const meta = body as Record<string, unknown>;
  const redirectUris = Array.isArray(meta.redirect_uris) ? meta.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (redirectUris.length === 0) return oauthError("invalid_redirect_uri", "redirect_uris is required");
  for (const uri of redirectUris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      return oauthError("invalid_redirect_uri", `Invalid redirect URI: ${uri}`);
    }
    const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
    if (parsed.protocol === "http:" && !loopback) return oauthError("invalid_redirect_uri", "Redirect URIs must use https");
  }
  const clientId = randomToken("cart_client_");
  const clientName = typeof meta.client_name === "string" ? meta.client_name.slice(0, 100) : undefined;
  await ctx.runMutation(internal.mcp.store.registerClient, { clientId, clientName, redirectUris });
  return json(
    {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    201,
  );
});

const token = httpAction(async (ctx, req) => {
  const p = await readParams(req);
  const accessToken = randomToken("cart_at_");
  const refreshToken = randomToken("cart_rt_");
  const tokenResponse = (scope: string) =>
    json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      refresh_token: refreshToken,
      scope,
    });

  if (p.grant_type === "authorization_code") {
    if (!p.code || !p.code_verifier || !p.client_id) return oauthError("invalid_request", "code, code_verifier and client_id are required");
    const code = await ctx.runMutation(internal.mcp.store.consumeAuthCode, { codeHash: await hashToken(p.code) });
    if (!code || code.clientId !== p.client_id) return oauthError("invalid_grant", "Authorization code is invalid or expired");
    if (p.redirect_uri && p.redirect_uri !== code.redirectUri) return oauthError("invalid_grant", "redirect_uri mismatch");
    if ((await pkceChallenge(p.code_verifier)) !== code.codeChallenge) return oauthError("invalid_grant", "PKCE verification failed");
    await ctx.runMutation(internal.mcp.store.issueTokens, {
      shopperId: code.shopperId,
      clientId: code.clientId,
      scope: code.scope,
      accessToken,
      refreshToken,
    });
    return tokenResponse(code.scope);
  }

  if (p.grant_type === "refresh_token") {
    if (!p.refresh_token || !p.client_id) return oauthError("invalid_request", "refresh_token and client_id are required");
    const rotated = await ctx.runMutation(internal.mcp.store.rotateRefreshToken, {
      refreshToken: p.refresh_token,
      clientId: p.client_id,
      accessToken,
      newRefreshToken: refreshToken,
    });
    if (!rotated) return oauthError("invalid_grant", "Refresh token is invalid");
    return tokenResponse(rotated.scope);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token");
});

const preflight = httpAction(async () => new Response(null, { status: 204, headers: CORS_HEADERS }));
const methodNotAllowed = httpAction(async () => new Response(null, { status: 405, headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" } }));
const prm = httpAction(async () => json(protectedResourceMetadata()));
const asMetadata = httpAction(async () => json(authorizationServerMetadata()));

export function registerMcpRoutes(http: HttpRouter) {
  http.route({ path: "/mcp", method: "POST", handler: mcpPost });
  http.route({ path: "/mcp", method: "GET", handler: methodNotAllowed });
  http.route({ path: "/mcp", method: "DELETE", handler: methodNotAllowed });
  http.route({ path: "/mcp", method: "OPTIONS", handler: preflight });

  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    http.route({ path, method: "GET", handler: prm });
    http.route({ path, method: "OPTIONS", handler: preflight });
  }
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
    http.route({ path, method: "GET", handler: asMetadata });
    http.route({ path, method: "OPTIONS", handler: preflight });
  }

  http.route({ path: "/oauth/register", method: "POST", handler: register });
  http.route({ path: "/oauth/register", method: "OPTIONS", handler: preflight });
  http.route({ path: "/oauth/authorize", method: "GET", handler: authorizeGet });
  http.route({ path: "/oauth/authorize", method: "POST", handler: authorizePost });
  http.route({ path: "/oauth/token", method: "POST", handler: token });
  http.route({ path: "/oauth/token", method: "OPTIONS", handler: preflight });
}
