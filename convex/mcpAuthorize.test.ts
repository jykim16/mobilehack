/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { hashToken } from "./lib/tokens";

const modules = import.meta.glob("./**/*.ts");
const REDIRECT = "https://client.example/callback";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

async function setup() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const shopperId = await ctx.db.insert("users", { name: "Shopper", email: "stage@cart.app", isAnonymous: false });
    await ctx.db.insert("mcpOAuthClients", { clientId: "client_test", clientName: "Muse", redirectUris: [REDIRECT], createdAt: Date.now() });
    return { shopperId };
  });
  return { t, ...ids };
}

function authorize(t: ReturnType<typeof convexTest>, credential: string) {
  return t.fetch("/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      response_type: "code",
      client_id: "client_test",
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "state123",
      scope: "cart",
      code: credential,
    }).toString(),
  });
}

describe("oauth authorize credentials", () => {
  test("a valid agent token authorizes the connection", async () => {
    const { t, shopperId } = await setup();
    const token = "cart_ct_valid_token_value";
    await t.run(async (ctx) =>
      ctx.db.insert("mcpTokens", { tokenHash: await hashToken(token), kind: "connection", shopperId, scope: "cart", createdAt: Date.now() }),
    );
    const response = await authorize(t, token);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!);
    expect(location.searchParams.get("code")).toMatch(/^cart_code_/);
    expect(location.searchParams.get("state")).toBe("state123");
  });

  test("a revoked agent token is refused with a clear message", async () => {
    const { t, shopperId } = await setup();
    const token = "cart_ct_revoked_token_value";
    await t.run(async (ctx) =>
      ctx.db.insert("mcpTokens", {
        tokenHash: await hashToken(token),
        kind: "connection",
        shopperId,
        scope: "cart",
        createdAt: Date.now(),
        revokedAt: Date.now(),
      }),
    );
    const response = await authorize(t, token);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("was revoked");
  });

  test("a pairing code still authorizes the connection", async () => {
    const { t, shopperId } = await setup();
    await t.run(async (ctx) =>
      ctx.db.insert("mcpPairingCodes", { code: "ABC234", shopperId, expiresAt: Date.now() + 60_000, used: false }),
    );
    const response = await authorize(t, "abc234");
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).searchParams.get("code")).toMatch(/^cart_code_/);
  });

  test("a pairing code dies with the connection that issued it", async () => {
    const { t, shopperId } = await setup();
    const connectionId = await t.run(async (ctx) =>
      ctx.db.insert("mcpTokens", { shopperId, kind: "connection", scope: "cart", label: "Agent", createdAt: Date.now() }),
    );
    const live = await t.run(async (ctx) =>
      ctx.db.insert("mcpPairingCodes", { code: "LIVE23", shopperId, connectionId, expiresAt: Date.now() + 60_000, used: false }),
    );
    expect((await authorize(t, "LIVE23")).status).toBe(302);

    await t.run(async (ctx) => ctx.db.patch("mcpTokens", connectionId, { revokedAt: Date.now() }));
    await t.run(async (ctx) => ctx.db.patch("mcpPairingCodes", live, { used: false }));
    const afterRevoke = await authorize(t, "LIVE23");
    expect(afterRevoke.status).toBe(400);
    expect(await afterRevoke.text()).toContain("invalid");
  });

  test("an unknown token is refused without revealing anything", async () => {
    const { t } = await setup();
    const response = await authorize(t, "cart_ct_nope");
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("not recognized");
  });
});
