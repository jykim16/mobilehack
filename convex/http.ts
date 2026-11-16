import { v } from "convex/values";
import { internal } from "./_generated/api";
import { httpRouter } from "convex/server";
import { httpAction, type ActionCtx } from "./_generated/server";
import { auth } from "./auth";
import { registerMcpRoutes } from "./mcp/http";
import { digest, verifyWebhook } from "./lib/whop";

const http = httpRouter();

auth.addHttpRoutes(http);
registerMcpRoutes(http);

type WhopPaymentShape = {
  id?: string;
  amount?: number | string | null;
  currency?: string | null;
  status?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | null;
};

const cents = (amount: unknown): number | null => {
  if (typeof amount === "number") return Math.round(amount * 100);
  if (typeof amount === "string" && amount.trim() !== "" && Number.isFinite(Number(amount))) {
    return Math.round(Number(amount) * 100);
  }
  return null;
};

/**
 * Whop's payment webhook. The raw body is verified before anything is read from it,
 * the delivery is recorded once by its event id, and the work happens in its own
 * step so this answers inside Whop's five-second window. A missing secret, a bad
 * signature or a stale timestamp is recorded as unverified and never processed.
 */
const whopWebhook = httpAction(async (ctx, request): Promise<Response> => {
    const rawBody = await request.text();
    const verification = await verifyWebhook(rawBody, {
      id: request.headers.get("webhook-id"),
      timestamp: request.headers.get("webhook-timestamp"),
      signature: request.headers.get("webhook-signature"),
    });

    let body: { id?: string; type?: string; data?: WhopPaymentShape } | null = null;
    try {
      body = JSON.parse(rawBody) as { id?: string; type?: string; data?: WhopPaymentShape };
    } catch {
      body = null;
    }
    const eventId = verification.eventId ?? body?.id ?? `${digest(rawBody)}`;
    const type = body?.type ?? "unknown";

    if (!verification.verified) {
      await ctx.runMutation(internal.whop.saveEvent, {
        providerEventId: eventId,
        type,
        signatureVerified: false,
        payloadDigest: digest(rawBody),
      });
      console.warn("Whop webhook rejected:", verification.reason, type, eventId);
      return new Response(JSON.stringify({ ok: false, reason: verification.reason }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const recorded = await ctx.runMutation(internal.whop.saveEvent, {
      providerEventId: eventId,
      type,
      signatureVerified: true,
      payloadDigest: digest(rawBody),
    });
    if (!recorded.firstTime) {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const payment = body?.data ?? null;
    if (!payment?.id || !/^payment\./.test(type)) {
      await ctx.runMutation(internal.whop.finishEvent, {
        eventId: recorded.eventId,
        outcome: `verified ${type} delivery with no payment to record`,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }

    const metadata = payment.metadata ?? {};
    await ctx.scheduler.runAfter(0, internal.whop.handlePaymentEvent, {
      eventId: recorded.eventId,
      type,
      providerPaymentId: payment.id,
      requestId: typeof metadata.requestId === "string" ? metadata.requestId : null,
      quoteVersion:
        typeof metadata.quoteVersion === "string"
          ? metadata.quoteVersion
          : typeof metadata.quoteVersion === "number"
            ? String(metadata.quoteVersion)
            : null,
      amountCents: cents(payment.amount),
      currency: payment.currency ?? null,
      failed: type !== "payment.succeeded",
    });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});

http.route({ path: "/whop/webhook", method: "POST", handler: whopWebhook });

export default http;
