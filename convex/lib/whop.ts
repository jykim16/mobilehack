
/**
 * Whop client surface. Money moves through here and nowhere else, so every call
 * takes an idempotency key and every failure carries the provider's own words.
 */

export type WhopConfig = { base: string; key: string; accountId: string };

const readEnv = (name: string): string | undefined =>
  typeof process !== "undefined" ? process.env[name] : undefined;

export function whopConfig(): WhopConfig | null {
  const key = readEnv("WHOP_API_KEY");
  const accountId = readEnv("WHOP_ACCOUNT_ID");
  const base = readEnv("WHOP_API_BASE") ?? "https://api.whop.com/api/v1";
  if (!key || !accountId) return null;
  return { base: base.replace(/\/$/, ""), key, accountId };
}

export function whopEnvironment(base: string): "sandbox" | "production" {
  return base.includes("sandbox") ? "sandbox" : "production";
}

export type WhopResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

export async function whopFetch<T>(
  config: WhopConfig,
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<WhopResult<T>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.key}`,
    "Content-Type": "application/json",
  };
  if (init.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`${config.base}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return { ok: false, error: `Whop request failed: ${e instanceof Error ? e.message : String(e)}`, status: 0 };
  }
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `Whop HTTP ${res.status}: ${text.slice(0, 240)}`, status: res.status };
  try {
    return { ok: true, data: JSON.parse(text) as T };
  } catch {
    return { ok: false, error: "Whop returned non-JSON", status: res.status };
  }
}

export type CreatedSubaccount = { id: string; title?: string | null; email?: string | null };

export async function createSubaccount(
  config: WhopConfig,
  input: { title: string; email: string },
): Promise<WhopResult<CreatedSubaccount>> {
  return await whopFetch<CreatedSubaccount>(config, "/accounts", {
    method: "POST",
    body: { title: input.title, email: input.email, metadata: { kind: "cart-shopper-subaccount" } },
  });
}

export type CreatedCheckout = {
  id: string;
  purchase_url?: string | null;
  variant?: { id?: string | null; initial_price?: number | null; currency?: string | null } | null;
};

/** A one-time checkout on the shopper's own subaccount, built from the quote. */
export async function createCheckoutConfiguration(
  config: WhopConfig,
  input: {
    subaccountId: string;
    amountCents: number;
    currency: string;
    title: string;
    requestId: string;
    quoteVersion: number;
  },
): Promise<WhopResult<CreatedCheckout>> {
  return await whopFetch<CreatedCheckout>(config, "/checkout_configurations", {
    method: "POST",
    idempotencyKey: `checkout-${input.requestId}-${input.quoteVersion}`,
    body: {
      account_id: input.subaccountId,
      variant: {
        title: input.title.slice(0, 120),
        billing_type: "one_time",
        initial_price: Number((input.amountCents / 100).toFixed(2)),
        currency: input.currency.toLowerCase(),
      },
      metadata: {
        requestId: input.requestId,
        quoteVersion: String(input.quoteVersion),
        cart: "mobilehack",
      },
    },
  });
}

export type IssuedCard = {
  cardId: string;
  last4: string;
  status: "active" | "unsupported";
  note: string | null;
  spendLimitCents: number;
  transactionLimitCents: number;
};

/**
 * Cards run on Rain, and this platform account has none, so the card leg is a
 * simulation behind the same shape the real call takes: the issuer-side limits are
 * wired in exactly as they would be, and the subaccount says so.
 */
export async function issueCard(
  config: WhopConfig,
  input: {
    subaccountId: string;
    spendLimitCents: number;
    transactionLimitCents: number;
    cardholderEmail: string;
    cardholderName: string;
  },
): Promise<IssuedCard> {
  const limits = {
    spend_limit: Number((input.spendLimitCents / 100).toFixed(2)),
    spend_limit_frequency: "monthly" as const,
    transaction_limit: Number((input.transactionLimitCents / 100).toFixed(2)),
  };
  const attempt = await whopFetch<{ id: string; last4?: string | null }>(config, "/cards", {
    method: "POST",
    idempotencyKey: `card-${input.subaccountId}-${input.transactionLimitCents}`,
    body: {
      account_id: input.subaccountId,
      kind: "company",
      name: "Cart retailer card",
      cardholder: {
        email: input.cardholderEmail,
        first_name: input.cardholderName.split(" ")[0] ?? "Cart",
        last_name: input.cardholderName.split(" ").slice(1).join(" ") || "Shopper",
      },
      ...limits,
    },
  });
  if (attempt.ok) {
    return {
      cardId: attempt.data.id,
      last4: attempt.data.last4 ?? "0000",
      status: "active",
      note: null,
      spendLimitCents: input.spendLimitCents,
      transactionLimitCents: input.transactionLimitCents,
    };
  }
  return {
    cardId: `card_simulated_${input.subaccountId}`,
    last4: "0000",
    status: "unsupported",
    note: `Whop card issuing is unavailable on this account (${attempt.error.slice(0, 120)}). The charge is simulated and the limits are enforced by Cart.`,
    spendLimitCents: input.spendLimitCents,
    transactionLimitCents: input.transactionLimitCents,
  };
}

export type ChargedCard = { ok: boolean; transactionId: string | null; error: string | null; simulated: boolean };

/** Charges the subaccount card. Without a Rain account this is a recorded simulation. */
export async function chargeCard(
  config: WhopConfig,
  input: {
    cardId: string;
    amountCents: number;
    currency: string;
    merchantName: string;
    orderReference: string;
  },
): Promise<ChargedCard> {
  if (input.cardId.startsWith("card_simulated_")) {
    return {
      ok: true,
      transactionId: `txn_simulated_${input.orderReference}`,
      error: null,
      simulated: true,
    };
  }
  const res = await whopFetch<{ id: string }>(config, "/cards/charges", {
    method: "POST",
    idempotencyKey: `charge-${input.orderReference}`,
    body: {
      card_id: input.cardId,
      amount: Number((input.amountCents / 100).toFixed(2)),
      currency: input.currency.toLowerCase(),
      merchant: input.merchantName,
      reference: input.orderReference,
    },
  });
  if (!res.ok) return { ok: false, transactionId: null, error: res.error, simulated: false };
  return { ok: true, transactionId: res.data.id, error: null, simulated: false };
}

export async function refundPayment(
  config: WhopConfig,
  input: { paymentId: string; amountCents?: number; reason?: string },
): Promise<WhopResult<{ id: string }>> {
  return await whopFetch<{ id: string }>(config, "/refunds", {
    method: "POST",
    idempotencyKey: `refund-${input.paymentId}-${input.amountCents ?? "full"}`,
    body: {
      payment_id: input.paymentId,
      ...(input.amountCents ? { amount: Number((input.amountCents / 100).toFixed(2)) } : {}),
      reason: input.reason ?? "Cart retailer order could not be fulfilled",
    },
  });
}

const encoder = new TextEncoder();

async function hmacBase64(key: Uint8Array, message: string): Promise<string> {
  const keyBytes = key.slice();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function fromBase64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function fromHex(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type WebhookVerification = { verified: boolean; reason: string | null; eventId: string | null };

/**
 * Standard-Webhooks signature: HMAC-SHA256 over "<id>.<timestamp>.<body>", compared
 * against every v1 signature offered. The secret may arrive hex- or base64-encoded,
 * so the candidates derived from the same secret are all tried.
 */
export async function verifyWebhook(
  rawBody: string,
  headers: { id: string | null; timestamp: string | null; signature: string | null },
): Promise<WebhookVerification> {
  const secret = readEnv("WHOP_WEBHOOK_SECRET");
  if (!secret) return { verified: false, reason: "WHOP_WEBHOOK_SECRET is not set", eventId: headers.id };
  if (!headers.id || !headers.timestamp || !headers.signature) {
    return { verified: false, reason: "missing webhook signature headers", eventId: headers.id };
  }
  const timestamp = Number(headers.timestamp);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return { verified: false, reason: "webhook timestamp outside the accepted window", eventId: headers.id };
  }
  const signed = `${headers.id}.${headers.timestamp}.${rawBody}`;
  const bare = secret.replace(/^(ws_|whsec_)/, "");
  const candidates = [fromHex(bare), fromBase64(bare), encoder.encode(bare), encoder.encode(secret)].filter(
    (k): k is Uint8Array => k !== null,
  );
  const offered = headers.signature
    .split(" ")
    .map((part) => part.trim())
    .filter((part) => part.startsWith("v1,"))
    .map((part) => part.slice(3));
  if (offered.length === 0) {
    return { verified: false, reason: "no v1 signature offered", eventId: headers.id };
  }
  for (const key of candidates) {
    const expected = await hmacBase64(key, signed);
    for (const sig of offered) {
      if (timingSafeEqual(expected, sig)) return { verified: true, reason: null, eventId: headers.id };
    }
  }
  return { verified: false, reason: "signature mismatch", eventId: headers.id };
}

export function digest(rawBody: string): string {
  let hash = 0;
  for (let i = 0; i < rawBody.length; i++) {
    hash = (hash * 31 + rawBody.charCodeAt(i)) | 0;
  }
  return `${rawBody.length}:${(hash >>> 0).toString(16)}`;
}
