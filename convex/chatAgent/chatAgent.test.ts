// @vitest-environment node
/// <reference types="vite/client" />

import { convexTest } from "convex-test";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import repoFixtures from "../../src/chatAgent/__fixtures__/cart-agent-fixtures.json";
import {
  MAX_CLARIFICATION_QUESTIONS,
  summarizeClarificationAnswers,
  validateAgentCard,
  validateChatMessage,
  type AgentCard,
  type ChatMessage,
  type CheckoutApprovalCard,
  type ClarificationRequestCard,
  type OrderReceiptCard,
  type PriceHistoryCard,
  type ProductEvidenceCard,
} from "../../src/chatAgent/types";
import {
  findActiveClarification,
  findPendingApproval,
} from "../../src/chatAgent/useCartAgentChat";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import schema from "../schema";
import { enforceClarificationCap } from "./validators";

const modules = import.meta.glob("/convex/**/*.*s");

async function createAuthenticatedShopper(t: ReturnType<typeof convexTest>, name: string) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const uid = await ctx.db.insert("users", { name, isAnonymous: true });
    const sid = await ctx.db.insert("authSessions", {
      userId: uid,
      expirationTime: Date.now() + 24 * 3600_000,
    });
    return { userId: uid, sessionId: sid };
  });
  return {
    userId,
    asShopper: t.withIdentity({ subject: `${userId}|${sessionId}` }),
  };
}

/**
 * Settles immediate `runAfter(0, ...)` scheduled functions (such as `runtime.runTurn`)
 * without needing to advance 30-minute quote expiry timers.
 */
async function flushImmediateTurn(t: ReturnType<typeof convexTest>) {
  await vi.advanceTimersByTimeAsync(50);
  await t.finishInProgressScheduledFunctions();
}

describe("Cart Agent LangGraph backend & contract fixtures", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("validates canonical cart-agent-fixtures.json against TypeScript and Convex schema validators", async () => {
    const driveFixturePath =
      "/home/user/.capy/drive/project-mobilehack/handoffs/cart-agent-fixtures.json";
    if (fs.existsSync(driveFixturePath)) {
      const driveData = JSON.parse(fs.readFileSync(driveFixturePath, "utf8"));
      expect(repoFixtures).toEqual(driveData);
    }

    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Fixture shopper");
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    const fixtureEntries = Object.entries(repoFixtures.fixturesByKind);
    expect(fixtureEntries.length).toBeGreaterThanOrEqual(7);

    for (const [fixtureName, rawMessage] of fixtureEntries) {
      const check = validateChatMessage(rawMessage);
      expect(check.errors, `Fixture ${fixtureName} failed TS validation`).toEqual([]);
      expect(check.valid).toBe(true);

      const typedMsg = rawMessage as unknown as ChatMessage;
      for (const card of typedMsg.cards) {
        const cardCheck = validateAgentCard(card);
        expect(cardCheck.valid, `Fixture card in ${fixtureName} invalid`).toBe(true);
      }

      if (typedMsg.role === "assistant") {
        await t.mutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: typedMsg.text,
          cards: typedMsg.cards as never,
          clientActions: typedMsg.clientActions,
          status: typedMsg.status,
          idempotencyKey: `fixture_${fixtureName}`,
        });
      }
    }

    const storedMessages = await asShopper.query(api.chatAgent.api.listMessages, { threadId });
    expect(storedMessages.length).toBe(7);

    const answeredCard = (
      repoFixtures.fixturesByKind.clarification_request_answered.cards[0] as unknown
    ) as ClarificationRequestCard;
    expect(summarizeClarificationAnswers(answeredCard)).toBe(
      "Under $250 all-in · All-flight comfort",
    );
  });

  it("enforces the 1..4 clarifying-question cap strictly", () => {
    const makeQ = (idx: number) => ({
      id: `q_${idx}`,
      prompt: `Question ${idx}?`,
      kind: "single_select" as const,
      options: [
        { id: `opt_${idx}_a`, label: "Option A", value: "a" },
        { id: `opt_${idx}_b`, label: "Option B", value: "b" },
      ],
    });

    const sixQuestions = [1, 2, 3, 4, 5, 6].map(makeQ);
    const capped = enforceClarificationCap(sixQuestions);
    expect(capped).toHaveLength(MAX_CLARIFICATION_QUESTIONS);
    expect(capped.map((q) => q.id)).toEqual(["q_1", "q_2", "q_3", "q_4"]);

    expect(() => enforceClarificationCap([])).toThrow(/between 1 and 4 questions/);
  });

  it("pauses on LangGraph clarification interrupt (1-2 questions) and resumes via structured chips into full enrichment + Amazon bridge", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Bao");

    // Seed multi-retailer demo cart (Best Buy AirFly Pro)
    await asShopper.mutation(api.demo.setupMyCart, {});
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    // Turn 1: Underspecified prompt -> pauses at await_clarification
    const sendRes = await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "I need wireless noise-cancelling headphones for long flights.",
      idempotencyKey: "turn_1_prompt",
      amazonContext: { status: "connected" },
    });
    expect(sendRes.status).toBe("running");

    await flushImmediateTurn(t);

    const pausedThread = await asShopper.query(api.chatAgent.api.getThread, { threadId });
    expect(pausedThread.status).toBe("awaiting_clarification");
    expect(pausedThread.activeClarificationId).toBeTruthy();

    const msgsAfterClarify = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    expect(msgsAfterClarify).toHaveLength(2);

    const activeClar = findActiveClarification(
      msgsAfterClarify,
      pausedThread.activeClarificationId,
    );
    expect(activeClar).not.toBeNull();
    expect(activeClar!.questions.length).toBeGreaterThanOrEqual(1);
    expect(activeClar!.questions.length).toBeLessThanOrEqual(4);
    expect(activeClar!.questions).toHaveLength(2);
    expect(activeClar!.questions[0].kind).toBe("price_range");
    expect(activeClar!.questions[0].priceRangePreset?.currency).toBe("USD");

    // Verify Sony XM5 has NOT been added before clarification is answered
    const cartBeforeResume = await asShopper.query(api.cart.listItems, {});
    expect(cartBeforeResume).toHaveLength(1); // Only the seeded AirFly Pro

    // Turn 2: Submit structured clarification options ($250 all-in + Flight comfort)
    await asShopper.mutation(api.chatAgent.api.submitClarification, {
      threadId,
      clarificationId: activeClar!.clarificationId,
      answers: {
        budget: "25000",
        priority: "Comfort on long flights",
      },
    });

    await flushImmediateTurn(t);

    const resumedThread = await asShopper.query(api.chatAgent.api.getThread, { threadId });
    expect(resumedThread.status).toBe("idle");
    expect(resumedThread.activeClarificationId).toBeNull();

    const msgsAfterResume = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    expect(msgsAfterResume).toHaveLength(3);

    // Earlier clarification card is now marked "answered" with answers echoed
    const updatedClarCard = msgsAfterResume[1].cards[0] as ClarificationRequestCard;
    expect(updatedClarCard.status).toBe("answered");
    expect(updatedClarCard.answers).toEqual({
      budget: "25000",
      priority: "Comfort on long flights",
    });

    // Latest assistant turn carries cart_action + product_evidence + amazon_sync_cart_add
    const fulfillMsg = msgsAfterResume[2];
    expect(fulfillMsg.clientActions).toEqual([
      {
        type: "amazon_sync_cart_add",
        url: "https://www.amazon.com/dp/B09XS7JWHH",
        asin: "B09XS7JWHH",
        variantLabel: "Black",
        quantity: 1,
      },
    ]);

    const cartCard = fulfillMsg.cards.find((c) => c.kind === "cart_action");
    const evidenceCard = fulfillMsg.cards.find(
      (c): c is ProductEvidenceCard => c.kind === "product_evidence",
    );
    expect(cartCard).toBeDefined();
    expect(evidenceCard).toBeDefined();
    expect(evidenceCard!.item.product?.title).toContain("Sony WH-1000XM5");
    expect(evidenceCard!.item.decision?.targetCents).toBe(25000);
    expect(evidenceCard!.item.decision?.priorities).toContain("Comfort on long flights");
    expect(evidenceCard!.item.decision?.targetMet).toBe(false); // $303.13 > $250.00
    expect(evidenceCard!.item.sections).toHaveLength(5);
    expect(evidenceCard!.item.sections.every((s) => s.status === "ready")).toBe(true);

    // Prose spotlights the hidden new_criterion ("Wired listening and audio quality") and AirFly synergy
    expect(fulfillMsg.text).toContain("Wired listening and audio quality");
    expect(fulfillMsg.text).toContain("AirFly Pro");
  });

  it("resumes pending clarification cleanly from either a free-form sendMessage or Skip", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Freeform shopper");

    // Path A: Free-form reply via sendMessage
    const { threadId: threadA } = await asShopper.mutation(
      api.chatAgent.api.getOrCreateThread,
      {},
    );
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId: threadA,
      text: "Looking for ANC headphones for flights",
      idempotencyKey: "ff_1",
    });
    await flushImmediateTurn(t);

    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId: threadA })).status).toBe(
      "awaiting_clarification",
    );

    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId: threadA,
      text: "Keep it under $310 all-in, silver color, wired audio matters most",
      idempotencyKey: "ff_2",
    });
    await flushImmediateTurn(t);

    const stateA = await asShopper.query(api.chatAgent.api.getThread, { threadId: threadA });
    expect(stateA.status).toBe("idle");
    const msgsA = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId: threadA,
    })) as ChatMessage[];
    const clarCardA = msgsA[1].cards[0] as ClarificationRequestCard;
    expect(clarCardA.status).toBe("answered");

    const evCardA = msgsA[3].cards.find(
      (c): c is ProductEvidenceCard => c.kind === "product_evidence",
    );
    expect(evCardA?.item.variant?.label).toBe("Silver");
    expect(evCardA?.item.decision?.targetCents).toBe(31000);
    expect(evCardA?.item.decision?.priorities).toContain("Wired listening and audio quality");

    // Path B: Skip clarification
    const { threadId: threadB } = await asShopper.mutation(api.chatAgent.api.createThread, {});
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId: threadB,
      text: "Recommend travel headphones",
      idempotencyKey: "skip_1",
    });
    await flushImmediateTurn(t);

    const threadBState = await asShopper.query(api.chatAgent.api.getThread, {
      threadId: threadB,
    });
    expect(threadBState.activeClarificationId).toBeTruthy();

    await asShopper.mutation(api.chatAgent.api.submitClarification, {
      threadId: threadB,
      clarificationId: threadBState.activeClarificationId!,
      answers: {},
      skipped: true,
    });
    await flushImmediateTurn(t);

    const msgsB = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId: threadB,
    })) as ChatMessage[];
    const clarCardB = msgsB[1].cards[0] as ClarificationRequestCard;
    expect(clarCardB.status).toBe("skipped");
    expect(summarizeClarificationAnswers(clarCardB)).toBe("Skipped preferences");
    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId: threadB })).status).toBe(
      "idle",
    );
  });

  it("handles price drop -> price_history card -> human-in-the-loop checkout interrupt -> blocks unapproved or stale-quote orders -> places order only on valid quoteVersion approval", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Checkout shopper");
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    // Directly well-specified prompt (URL + target $250 + comfort priority) -> skips clarification
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Save https://www.amazon.com/dp/B09XS7JWHH under $250 all-in for flight comfort",
      idempotencyKey: "co_1",
    });
    await flushImmediateTurn(t);

    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId })).status).toBe("idle");

    // Simulate price drop ($279.99 -> $229.99; $249.00 all-in <= $250.00 target)
    await asShopper.mutation(api.demo.advancePrice, {});

    // Ask about price drop
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Did the price drop? Show price history.",
      idempotencyKey: "co_2",
    });
    await flushImmediateTurn(t);

    let messages = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const priceMsg = messages[messages.length - 1];
    const priceCard = priceMsg.cards.find(
      (c): c is PriceHistoryCard => c.kind === "price_history",
    );
    expect(priceCard).toBeDefined();
    expect(priceCard!.currentCents).toBe(22999);
    expect(priceCard!.allInTotalCents).toBe(24900);
    expect(priceCard!.targetCents).toBe(25000);
    expect(priceCard!.targetMet).toBe(true);
    expect(priceCard!.simulated).toBe(true);

    // Request checkout while Amazon WebView is signed_out -> pauses at await_checkout_approval
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Let's check out the Sony headphones now",
      idempotencyKey: "co_3",
      amazonContext: { status: "signed_out" },
    });
    await flushImmediateTurn(t);

    const approvalThread = await asShopper.query(api.chatAgent.api.getThread, { threadId });
    expect(approvalThread.status).toBe("awaiting_approval");
    expect(approvalThread.pendingRequestId).toBeTruthy();

    messages = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const pendingCard = findPendingApproval(
      messages,
      approvalThread.pendingRequestId,
      "signed_out",
    );
    expect(pendingCard).not.toBeNull();
    expect(pendingCard!.quote.totalCents).toBe(24900);
    expect(pendingCard!.quote.simulated).toBe(true);
    expect(pendingCard!.amazonSignInRequired).toBe(true);

    // Reactive client helper flips amazonSignInRequired to false once WKWebView signs in
    const connectedCard = findPendingApproval(
      messages,
      approvalThread.pendingRequestId,
      "connected",
    );
    expect(connectedCard?.amazonSignInRequired).toBe(false);

    // SAFETY INVARIANT 1: Zero orders exist before explicit approval
    expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);

    // SAFETY INVARIANT 2: Typing "yes buy it!" in free-form chat MUST NOT place an order
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Yes buy it please!",
      idempotencyKey: "co_text_attempt",
    });
    await flushImmediateTurn(t);
    expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);
    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId })).status).toBe(
      "awaiting_approval",
    );

    // SAFETY INVARIANT 3: Stale quoteVersion is rejected without placing an order
    const staleRes = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: pendingCard!.requestId as Id<"purchaseRequests">,
      quoteVersion: pendingCard!.quoteVersion + 5,
      decision: "approve",
    });
    expect(staleRes.outcome).toBe("stale_quote");
    expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);

    // Explicit shopper approval bound to exact quoteVersion -> places order & resumes LangGraph
    const approveRes = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: pendingCard!.requestId as Id<"purchaseRequests">,
      quoteVersion: pendingCard!.quoteVersion,
      decision: "approve",
    });
    expect(approveRes.outcome).toBe("approved");
    expect(approveRes.request.order?.status).toBe("placed");

    // Idempotent repeat approval places zero extra orders
    const repeatRes = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: pendingCard!.requestId as Id<"purchaseRequests">,
      quoteVersion: pendingCard!.quoteVersion,
      decision: "approve",
    });
    expect(repeatRes.outcome).toBe("already_approved");

    const purchases = await asShopper.query(api.purchases.listPurchases, {});
    expect(purchases).toHaveLength(1);
    expect(purchases[0].quote.totalCents).toBe(24900);

    const finalThread = await asShopper.query(api.chatAgent.api.getThread, { threadId });
    expect(finalThread.status).toBe("idle");
    expect(finalThread.pendingRequestId).toBeNull();

    const finalMessages = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const receiptMsg = finalMessages[finalMessages.length - 1];
    expect(receiptMsg.clientActions).toEqual([{ type: "amazon_refresh_orders" }]);

    const receiptCard = receiptMsg.cards.find(
      (c): c is OrderReceiptCard => c.kind === "order_receipt",
    );
    expect(receiptCard).toBeDefined();
    expect(receiptCard!.status).toBe("placed");
    expect(receiptCard!.orderRef).toMatch(/^CART-/);
    expect(receiptCard!.simulated).toBe(true);
  });

  it("supports deferring a checkout quote without placing any order", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Defer shopper");
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Add https://www.amazon.com/dp/B09XS7JWHH and lock a quote",
      idempotencyKey: "def_1",
    });
    await flushImmediateTurn(t);

    const paused = await asShopper.query(api.chatAgent.api.getThread, { threadId });
    expect(paused.status).toBe("awaiting_approval");

    const msgs = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const approvalCard = msgs
      .flatMap((m: ChatMessage) => m.cards)
      .find((c: AgentCard): c is CheckoutApprovalCard => c.kind === "checkout_approval")!;

    const deferRes = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: approvalCard.requestId as Id<"purchaseRequests">,
      quoteVersion: approvalCard.quoteVersion,
      decision: "defer",
    });
    expect(deferRes.outcome).toBe("deferred");
    expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);
    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId })).status).toBe("idle");
  });

  it("enforces authentication and strict per-shopper thread ownership", async () => {
    const t = convexTest(schema, modules);
    const { asShopper: shopperA } = await createAuthenticatedShopper(t, "Shopper A");
    const { asShopper: shopperB } = await createAuthenticatedShopper(t, "Shopper B");

    // Unauthenticated rejected
    await expect(t.mutation(api.chatAgent.api.getOrCreateThread, {})).rejects.toThrow(
      /Sign in first/,
    );

    const { threadId } = await shopperA.mutation(api.chatAgent.api.getOrCreateThread, {});

    // Shopper B cannot read, message, or submit clarifications on Shopper A's thread
    await expect(
      shopperB.query(api.chatAgent.api.getThread, { threadId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      shopperB.query(api.chatAgent.api.listMessages, { threadId }),
    ).rejects.toThrow(/not found/i);
    await expect(
      shopperB.mutation(api.chatAgent.api.sendMessage, {
        threadId,
        text: "Intrude",
        idempotencyKey: "intrude_1",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("re-quotes instead of placing an order if material terms change between quote and approval, and updates order_receipt tracking reactively", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Requote shopper");
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    // Add hero item and lock a quote at initial $279.99 ($303.13 all-in)
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Add https://www.amazon.com/dp/B09XS7JWHH and lock a quote",
      idempotencyKey: "rq_1",
    });
    await flushImmediateTurn(t);

    let msgs = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const initialApproval = msgs
      .flatMap((m: ChatMessage) => m.cards)
      .find((c: AgentCard): c is CheckoutApprovalCard => c.kind === "checkout_approval")!;
    expect(initialApproval.quoteVersion).toBe(1);
    expect(initialApproval.quote.totalCents).toBe(30313);

    // Price changes BEFORE shopper clicks approve!
    await asShopper.mutation(api.demo.advancePrice, {});

    const firstAttempt = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: initialApproval.requestId as Id<"purchaseRequests">,
      quoteVersion: 1,
      decision: "approve",
    });
    // Material terms changed -> order is NOT placed; request resets to quoteVersion 2 ($249.00)
    expect(firstAttempt.outcome).toBe("stale_quote");
    expect(firstAttempt.request.quoteVersion).toBe(2);
    expect(firstAttempt.request.quote?.totalCents).toBe(24900);
    expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);
    expect((await asShopper.query(api.chatAgent.api.getThread, { threadId })).status).toBe(
      "awaiting_approval",
    );

    // Approving quoteVersion 2 succeeds and places the order at $249.00
    const secondAttempt = await asShopper.action(api.chatAgent.api.decideCheckout, {
      threadId,
      requestId: initialApproval.requestId as Id<"purchaseRequests">,
      quoteVersion: 2,
      decision: "approve",
    });
    expect(secondAttempt.outcome).toBe("approved");
    expect(secondAttempt.request.order?.status).toBe("placed");

    // Advance 25s so SimulatedAmazonAdapter transitions shipment to "shipped" with tracking
    await vi.advanceTimersByTimeAsync(25_000);
    await t.finishInProgressScheduledFunctions();

    msgs = (await asShopper.query(api.chatAgent.api.listMessages, {
      threadId,
    })) as ChatMessage[];
    const hydratedReceipt = msgs
      .flatMap((m: ChatMessage) => m.cards)
      .find((c: AgentCard): c is OrderReceiptCard => c.kind === "order_receipt")!;
    expect(hydratedReceipt.shipment?.status).toBe("shipped");
    expect(hydratedReceipt.shipment?.trackingNumber).toBeTruthy();
    expect(hydratedReceipt.shipment?.eta).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles follow-up turns for return terms, quantity updates, live Amazon offers, and item removal", async () => {
    const t = convexTest(schema, modules);
    const { asShopper } = await createAuthenticatedShopper(t, "Followup shopper");
    const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Save https://www.amazon.com/dp/B09XS7JWHH under $250 for flight comfort",
      idempotencyKey: "fu_1",
      amazonContext: {
        status: "connected",
        liveOffers: [
          {
            asin: "B09XS7JWHH",
            url: "https://www.amazon.com/dp/B09XS7JWHH",
            title: "Sony WH-1000XM5 Wireless Noise Canceling Headphones",
            variantLabel: "Black",
            priceCents: 27999,
          },
        ],
      },
    });
    await flushImmediateTurn(t);

    // Ask return policy comparison
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Compare return policy across Amazon and Best Buy",
      idempotencyKey: "fu_2",
    });
    await flushImmediateTurn(t);

    // Update quantity
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Change quantity to 2",
      idempotencyKey: "fu_3",
    });
    await flushImmediateTurn(t);

    const itemsAfterQty = await asShopper.query(api.cart.listItems, {});
    expect(itemsAfterQty[0].quantity).toBe(2);

    // Remove item
    await asShopper.mutation(api.chatAgent.api.sendMessage, {
      threadId,
      text: "Remove Sony from my cart",
      idempotencyKey: "fu_4",
    });
    await flushImmediateTurn(t);

    expect(await asShopper.query(api.cart.listItems, {})).toHaveLength(0);
  });

  it("recalls prior Supermemory shopper snippets and saves completed exchanges without bypassing checkout approval", async () => {
    const supermemoryMod = await import("../supermemory");
    const recallSpy = vi
      .spyOn(supermemoryMod, "recallShopperMemories")
      .mockResolvedValue(["Shopper prefers under $250 all-in and always approves quotes manually."]);
    const saveSpy = vi.spyOn(supermemoryMod, "saveShopperExchange").mockResolvedValue(undefined);

    try {
      const t = convexTest(schema, modules);
      const { userId, asShopper } = await createAuthenticatedShopper(t, "Memory shopper");
      const { threadId } = await asShopper.mutation(api.chatAgent.api.getOrCreateThread, {});

      await asShopper.mutation(api.chatAgent.api.sendMessage, {
        threadId,
        text: "Add https://www.amazon.com/dp/B09XS7JWHH and lock a quote",
        idempotencyKey: "mem_1",
      });
      await flushImmediateTurn(t);

      const expectedShopperKey = String(userId).replace(/[^a-zA-Z0-9_:-]/g, ":");
      expect(recallSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          shopperId: expectedShopperKey,
          query: "Add https://www.amazon.com/dp/B09XS7JWHH and lock a quote",
        }),
      );
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          shopperId: expectedShopperKey,
          threadId: String(threadId),
        }),
      );

      // Even with recalled memories, checkout STILL pauses on quoteVersion approval
      expect((await asShopper.query(api.chatAgent.api.getThread, { threadId })).status).toBe(
        "awaiting_approval",
      );
      expect(await asShopper.query(api.purchases.listPurchases, {})).toHaveLength(0);
    } finally {
      recallSpy.mockRestore();
      saveSpy.mockRestore();
    }
  });
});
