"use node";

import { Annotation, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { SECTION_NAMES, type SectionName } from "../lib/validators";
import { recallShopperMemories, saveShopperExchange } from "../supermemory";
import { ConvexCheckpointSaver } from "./checkpointer";
import {
  extractAsinFromUrl,
  formatDollars,
  generateClarificationQuestions,
  mergeClarificationResolution,
  parseShoppingSignals,
  synthesizeItemEvidenceText,
} from "./llm";
import {
  enforceClarificationCap,
  type AgentCard,
  type AmazonClientAction,
  type AmazonSessionContext,
  type CartActionCard,
  type CartItemSnapshot,
  type CheckoutApprovalCard,
  type ClarificationAnswers,
  type ClarificationQuestion,
  type OrderReceiptCard,
  type PriceHistoryCard,
  type ProductEvidenceCard,
} from "./validators";

export type ClarificationInterruptPayload = {
  type: "await_clarification";
  clarificationId: string;
  questions: ClarificationQuestion[];
};

export type ClarificationResumePayload =
  | { kind: "answered"; clarificationId: string; answers: ClarificationAnswers }
  | { kind: "skipped"; clarificationId: string; answers?: ClarificationAnswers }
  | { kind: "freeform"; clarificationId: string; text: string };

export type CheckoutInterruptPayload = {
  type: "await_checkout_approval";
  requestId: string;
  itemId: string;
  offerId: string;
  quoteVersion: number;
  expiresAt: number;
};

export type CheckoutResumePayload = {
  decision: "approve" | "defer";
  outcome: string;
  requestId: string;
};

export const CartAgentState = Annotation.Root({
  userPrompt: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "",
  }),
  turnKey: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => "turn_0",
  }),
  clarifiedInTurn: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  needsClarification: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  targetCents: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  targetAppliesTo: Annotation<"all_in" | "item_price">({
    reducer: (_prev, next) => next,
    default: () => "all_in",
  }),
  priorities: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  variantHint: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  retailerHint: Annotation<"amazon" | "bestbuy" | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  quantityHint: Annotation<number | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  activeItemId: Annotation<string | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  recalledMemories: Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  pendingClarification: Annotation<ClarificationInterruptPayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  needsCheckout: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
  checkoutTarget: Annotation<{
    itemId: string;
    offerId: string;
    quantity: number;
    reason: string;
  } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  pendingCheckout: Annotation<CheckoutInterruptPayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  checkoutResolution: Annotation<CheckoutResumePayload | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type CartAgentEnv = {
  ctx: ActionCtx;
  shopperId: Id<"users">;
  threadId: Id<"chatThreads">;
  amazonContext?: AmazonSessionContext;
};

async function ensureItemEnriched(
  ctx: ActionCtx,
  shopperId: Id<"users">,
  itemId: Id<"cartItems">,
): Promise<CartItemSnapshot> {
  let item = (await ctx.runQuery(internal.agent.getItem, {
    shopperId,
    itemId,
  })) as CartItemSnapshot;

  if (!item.offer) {
    await ctx.runAction(internal.enrichment.resolveOffer, {
      cartItemId: itemId,
    });
  }

  await ctx.runMutation(internal.enrichment.start, { cartItemId: itemId });
  item = (await ctx.runQuery(internal.agent.getItem, {
    shopperId,
    itemId,
  })) as CartItemSnapshot;

  const pendingSections: SectionName[] = SECTION_NAMES.filter((name) => {
    const found = item.sections.find((s) => s.section === name);
    return !found || (found.status !== "ready" && found.status !== "failed");
  });

  if (pendingSections.length > 0) {
    await Promise.all(
      pendingSections.map((section) =>
        ctx.runAction(internal.enrichment.runSection, {
          cartItemId: itemId,
          section,
        }),
      ),
    );
    item = (await ctx.runQuery(internal.agent.getItem, {
      shopperId,
      itemId,
    })) as CartItemSnapshot;
  }

  return item;
}

function buildCartActionCard(
  action: CartActionCard["action"],
  item: CartItemSnapshot,
  deduplicated?: boolean,
): CartActionCard {
  return {
    kind: "cart_action",
    action,
    itemId: item.id,
    productTitle: item.product?.title ?? item.url,
    variantLabel: item.variant?.label ?? item.offer?.variantLabel ?? null,
    retailerName: item.offer?.retailerName ?? "Retailer",
    quantity: item.quantity,
    priceCents: item.offer?.priceCents ?? item.price?.currentCents ?? null,
    deduplicated,
    enrichmentStatus: item.enrichmentStatus,
  };
}

function buildPriceHistoryCard(item: CartItemSnapshot): PriceHistoryCard {
  const history = item.priceHistory;
  const currentCents = item.offer?.priceCents ?? history?.currentCents ?? 0;
  const points = history?.points ?? [];
  return {
    kind: "price_history",
    itemId: item.id,
    productTitle: item.product?.title ?? item.url,
    variantLabel: item.variant?.label ?? item.offer?.variantLabel ?? null,
    retailerName: item.offer?.retailerName ?? "Retailer",
    currentCents,
    allInTotalCents: item.price?.totalCents ?? null,
    lowCents: history?.lowCents ?? currentCents,
    highCents: history?.highCents ?? currentCents,
    targetCents: item.decision?.targetCents ?? null,
    targetAppliesTo: item.decision?.targetAppliesTo ?? null,
    targetMet: item.decision?.targetMet ?? null,
    points,
    simulated:
      Boolean(item.offer?.simulated) || points.some((pt) => pt.simulated),
  };
}

function selectCartItemForPrompt(
  items: CartItemSnapshot[],
  prompt: string,
  activeItemId: string | null,
): CartItemSnapshot | null {
  if (items.length === 0) return null;
  const lower = prompt.toLowerCase();

  for (const item of items) {
    const title = item.product?.title.toLowerCase() ?? "";
    const brand = item.product?.brand?.toLowerCase() ?? "";
    if (
      (/\bsony\b|\bxm5\b|\bheadphone/i.test(lower) && /sony|xm5|headphone/i.test(title)) ||
      (/\bairfly\b|\btransmitter\b|\badapter\b|\bbest buy\b/i.test(lower) &&
        /airfly|twelve south/i.test(`${title} ${brand}`))
    ) {
      return item;
    }
  }

  if (activeItemId) {
    const active = items.find((i) => i.id === activeItemId);
    if (active) return active;
  }

  return items[0];
}

function shopperMemoryKey(shopperId: Id<"users">): string {
  return String(shopperId).replace(/[^a-zA-Z0-9_:-]/g, ":");
}

export function buildCartAgentGraph(env: CartAgentEnv) {
  const { ctx, shopperId, threadId, amazonContext } = env;
  const checkpointer = new ConvexCheckpointSaver(ctx);
  const memoryShopperId = shopperMemoryKey(shopperId);

  const persistAssistantTurn = async (
    args: Parameters<
      typeof ctx.runMutation<typeof internal.chatAgent.internal.appendAssistantMessage>
    >[1],
    userPromptForMemory: string,
  ) => {
    const res = await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, args);
    if (!res.deduplicated) {
      await saveShopperExchange({
        shopperId: memoryShopperId,
        userText: userPromptForMemory,
        assistantText: args.text,
        threadId: String(threadId),
      });
    }
    return res;
  };

  const intakeRouter = async (state: typeof CartAgentState.State) => {
    await ctx.runMutation(internal.demo.seedCatalog, {});
    const recalledMemories = await recallShopperMemories({
      shopperId: memoryShopperId,
      query: state.userPrompt,
    });
    const signals = parseShoppingSignals(state.userPrompt);

    const nextTargetCents = signals.budgetExplicit ? signals.targetCents : state.targetCents;
    const nextTargetAppliesTo = signals.budgetExplicit
      ? signals.targetAppliesTo
      : state.targetAppliesTo;
    const mergedPriorities = Array.from(new Set([...state.priorities, ...signals.priorities]));

    // Only ask clarifying questions on underspecified shopping / recommendation turns
    // when no direct URL was pasted and we haven't already clarified in this turn.
    const isDiscoveryShopTurn =
      signals.intentKind === "shop" &&
      signals.urls.length === 0 &&
      !signals.alsoWantsCheckout &&
      !state.clarifiedInTurn;

    const missingKeyDimension =
      !signals.budgetExplicit || !signals.specificTradeoffExplicit;

    const needsClarification = isDiscoveryShopTurn && missingKeyDimension;

    return {
      recalledMemories,
      needsClarification,
      needsCheckout: false,
      checkoutTarget: null,
      targetCents: nextTargetCents,
      targetAppliesTo: nextTargetAppliesTo,
      priorities: mergedPriorities,
      variantHint: signals.variantHint ?? state.variantHint,
      retailerHint: signals.retailerHint ?? state.retailerHint,
      quantityHint: signals.quantity,
    };
  };

  const buildClarification = async (state: typeof CartAgentState.State) => {
    const signals = parseShoppingSignals(state.userPrompt);
    const { introText, questions } = await generateClarificationQuestions(
      state.userPrompt,
      signals,
      state.recalledMemories,
    );
    const cappedQuestions = enforceClarificationCap(questions);
    const clarificationId = `clar_${state.turnKey.replace(/[^a-zA-Z0-9_]/g, "_")}`;

    await persistAssistantTurn(
      {
        threadId,
        text: introText,
        cards: [
          {
            kind: "clarification_request",
            clarificationId,
            status: "pending",
            questions: cappedQuestions,
          },
        ],
        threadStatus: "awaiting_clarification",
        activeClarificationId: clarificationId,
        pendingRequestId: null,
        lastError: null,
        idempotencyKey: `msg_clar_${state.turnKey}`,
      },
      state.userPrompt,
    );

    return {
      pendingClarification: {
        type: "await_clarification" as const,
        clarificationId,
        questions: cappedQuestions,
      },
    };
  };

  const awaitClarification = async (state: typeof CartAgentState.State) => {
    const payload = state.pendingClarification!;
    const resolution = interrupt<ClarificationInterruptPayload, ClarificationResumePayload>(
      payload,
    );

    const merged = mergeClarificationResolution(
      {
        targetCents: state.targetCents,
        targetAppliesTo: state.targetAppliesTo,
        priorities: state.priorities,
        variantHint: state.variantHint,
        retailerHint: state.retailerHint,
      },
      resolution.kind === "freeform"
        ? { kind: "freeform", text: resolution.text }
        : resolution.kind === "skipped"
          ? { kind: "skipped", answers: resolution.answers }
          : { kind: "answered", answers: resolution.answers },
    );

    return {
      clarifiedInTurn: true,
      needsClarification: false,
      pendingClarification: null,
      targetCents: merged.targetCents,
      targetAppliesTo: merged.targetAppliesTo,
      priorities: merged.priorities,
      variantHint: merged.variantHint,
      retailerHint: merged.retailerHint,
    };
  };

  const planAndExecute = async (state: typeof CartAgentState.State) => {
    const signals = parseShoppingSignals(state.userPrompt);
    const cartItems = (await ctx.runQuery(internal.agent.listItems, {
      shopperId,
    })) as CartItemSnapshot[];

    // 1. Order status / tracking inquiry
    if (signals.intentKind === "order_status") {
      const purchases = await ctx.runQuery(internal.chatAgent.internal.listPurchasesInternal, {
        shopperId,
      });
      if (purchases.length === 0) {
        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: "You have no placed orders yet. Ask me to check out an item in your cart whenever you want a binding quote.",
          cards: [],
          threadStatus: "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_exec_${state.turnKey}`,
        });
        return { needsCheckout: false };
      }

      const latest = purchases[0];
      const receiptCard: OrderReceiptCard = {
        kind: "order_receipt",
        orderId: latest.orderId,
        orderRef: latest.orderRef,
        requestId: latest.requestId,
        itemId: latest.itemId,
        status: latest.status,
        quote: latest.quote,
        shipment: latest.shipment,
        simulated: latest.simulated,
      };
      const shipSummary = latest.shipment?.trackingNumber
        ? `Status: ${latest.shipment.status} via ${latest.shipment.carrier ?? "carrier"} (${latest.shipment.trackingNumber})${latest.shipment.eta ? `, ETA ${latest.shipment.eta}` : ""}.`
        : `Order status is ${latest.status}${latest.shipment ? ` (${latest.shipment.status})` : ""}.`;

      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: `Latest order ${latest.orderRef} for ${latest.quote.productTitle} (${formatDollars(latest.quote.totalCents)} total). ${shipSummary}`,
        cards: [receiptCard],
        threadStatus: "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_exec_${state.turnKey}`,
      });
      return { needsCheckout: false };
    }

    // 2. Remove item
    if (signals.intentKind === "remove_item") {
      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId);
      if (!targetItem) {
        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: "Your cart is currently empty.",
          cards: [],
          threadStatus: "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_exec_${state.turnKey}`,
        });
        return { needsCheckout: false };
      }
      await ctx.runMutation(internal.chatAgent.internal.removeCartItem, {
        shopperId,
        itemId: targetItem.id as Id<"cartItems">,
      });
      const card = buildCartActionCard("removed", targetItem);
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: `Removed ${targetItem.product?.title ?? targetItem.url} from your cart.`,
        cards: [card],
        threadStatus: "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_exec_${state.turnKey}`,
      });
      return {
        needsCheckout: false,
        activeItemId: state.activeItemId === targetItem.id ? null : state.activeItemId,
      };
    }

    // 3. Quantity update
    if (signals.intentKind === "set_quantity" && state.quantityHint !== null) {
      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId);
      if (!targetItem) {
        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: "Add an item to your cart first before updating quantity.",
          cards: [],
          threadStatus: "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_exec_${state.turnKey}`,
        });
        return { needsCheckout: false };
      }
      await ctx.runMutation(internal.chatAgent.internal.setItemQuantity, {
        shopperId,
        itemId: targetItem.id as Id<"cartItems">,
        quantity: state.quantityHint,
      });
      const refreshed = (await ctx.runQuery(internal.agent.getItem, {
        shopperId,
        itemId: targetItem.id as Id<"cartItems">,
      })) as CartItemSnapshot;
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: `Updated ${refreshed.product?.title ?? "item"} quantity to ${refreshed.quantity}.`,
        cards: [buildCartActionCard("quantity_changed", refreshed)],
        threadStatus: "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_exec_${state.turnKey}`,
      });
      return { needsCheckout: false, activeItemId: refreshed.id };
    }

    // 4. Update buyer target / priorities on existing item
    if (signals.intentKind === "update_decision") {
      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId);
      if (targetItem) {
        const nextPriorities =
          state.priorities.length > 0
            ? state.priorities
            : (targetItem.decision?.priorities ?? []);
        const nextTarget = state.targetCents ?? targetItem.decision?.targetCents ?? undefined;
        await ctx.runMutation(internal.chatAgent.internal.updateItemDecision, {
          shopperId,
          itemId: targetItem.id as Id<"cartItems">,
          priorities: nextPriorities,
          targetCents: nextTarget,
          targetAppliesTo: state.targetAppliesTo,
        });
        const full = await ensureItemEnriched(
          ctx,
          shopperId,
          targetItem.id as Id<"cartItems">,
        );
        const cards: AgentCard[] = [
          buildCartActionCard("updated_decision", full),
          {
            kind: "product_evidence",
            itemId: full.id,
            item: full,
            featuredSection: "priceHistory",
          },
        ];
        const targetLabel =
          full.decision?.targetCents != null
            ? formatDollars(full.decision.targetCents)
            : "no cap";
        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: `Updated your target on ${full.product?.title ?? "this item"} to ${targetLabel} (${full.decision?.targetMet ? "currently met" : "watching for a price drop"}).`,
          cards,
          threadStatus: "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_exec_${state.turnKey}`,
        });
        return { needsCheckout: false, activeItemId: full.id };
      }
    }

    // 5. Price check / price drop inquiry
    if (signals.intentKind === "price_check") {
      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId);
      if (targetItem) {
        const full = await ensureItemEnriched(
          ctx,
          shopperId,
          targetItem.id as Id<"cartItems">,
        );
        const priceCard = buildPriceHistoryCard(full);
        const currentStr = formatDollars(priceCard.currentCents);
        const allInStr =
          priceCard.allInTotalCents != null
            ? ` (${formatDollars(priceCard.allInTotalCents)} all-in)`
            : "";
        const targetNote =
          priceCard.targetCents != null
            ? priceCard.targetMet
              ? `, beating your ${formatDollars(priceCard.targetCents)} target.`
              : `, ${formatDollars((priceCard.allInTotalCents ?? priceCard.currentCents) - priceCard.targetCents)} above your ${formatDollars(priceCard.targetCents)} target.`
            : `. Range: ${formatDollars(priceCard.lowCents)}–${formatDollars(priceCard.highCents)}.`;

        const proceedToCheckout = Boolean(
          signals.alsoWantsCheckout && full.offer,
        );

        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: `${priceCard.productTitle} on ${priceCard.retailerName} is ${currentStr}${allInStr}${targetNote}`,
          cards: [priceCard],
          threadStatus: proceedToCheckout ? "running" : "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_price_${state.turnKey}`,
        });

        if (proceedToCheckout && full.offer) {
          return {
            activeItemId: full.id,
            needsCheckout: true,
            checkoutTarget: {
              itemId: full.id,
              offerId: full.offer.id,
              quantity: full.quantity,
              reason:
                full.decision?.targetMet && full.decision.targetCents != null
                  ? `Meets your ${formatDollars(full.decision.targetCents)} all-in target.`
                  : `Requested checkout quote for ${full.product?.title ?? "cart item"}.`,
            },
          };
        }

        return { needsCheckout: false, activeItemId: full.id };
      }
    }

    // 6. Evidence follow-up / store comparison / cart inspection on existing item
    if (signals.intentKind === "evidence_followup") {
      if (cartItems.length === 0) {
        await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
          threadId,
          text: "Your cart is empty right now. Tell me what you're shopping for or paste a product link to pull price history, reviews, Reddit consensus, and return terms.",
          cards: [],
          threadStatus: "idle",
          activeClarificationId: null,
          lastError: null,
          idempotencyKey: `msg_exec_${state.turnKey}`,
        });
        return { needsCheckout: false };
      }

      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId)!;
      const full = await ensureItemEnriched(
        ctx,
        shopperId,
        targetItem.id as Id<"cartItems">,
      );
      const sec = full.sections.find((s) => s.section === signals.featuredSection);
      const offerComparison =
        full.offers.length > 1
          ? full.offers
              .map(
                (o) =>
                  `${o.retailerName} (${o.variantLabel ?? "Default"}): ${formatDollars(o.priceCents)} — ${o.returnSummary}`,
              )
              .join(" | ")
          : null;

      const replyParts: string[] = [];
      if (sec?.summary) {
        replyParts.push(sec.summary);
      }
      if (sec?.highlights && sec.highlights.length > 0) {
        replyParts.push(
          sec.highlights
            .slice(0, 2)
            .map((h) => `${h.label}: ${h.detail}`)
            .join(" "),
        );
      }
      if (/compare|best buy|amazon|store|retailer/i.test(state.userPrompt) && offerComparison) {
        replyParts.push(`Offers across stores: ${offerComparison}`);
      }

      const evidenceCard: ProductEvidenceCard = {
        kind: "product_evidence",
        itemId: full.id,
        item: full,
        featuredSection: signals.featuredSection,
      };

      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text:
          replyParts.join(" ") ||
          `Here is the latest ${signals.featuredSection} breakdown for ${full.product?.title ?? "your item"}.`,
        cards: [evidenceCard],
        threadStatus: "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_exec_${state.turnKey}`,
      });
      return { needsCheckout: false, activeItemId: full.id };
    }

    // 7. Direct checkout request on an existing cart item
    if (signals.intentKind === "checkout") {
      const targetItem = selectCartItemForPrompt(cartItems, state.userPrompt, state.activeItemId);
      if (targetItem) {
        const full = await ensureItemEnriched(
          ctx,
          shopperId,
          targetItem.id as Id<"cartItems">,
        );
        // Pick retailer offer matching retailerHint if requested, else item.offer
        const chosenOffer =
          (state.retailerHint
            ? full.offers.find(
                (o) =>
                  o.retailer === state.retailerHint &&
                  (!state.variantHint ||
                    o.variantLabel?.toLowerCase() === state.variantHint.toLowerCase()),
              )
            : null) ?? full.offer;

        if (chosenOffer) {
          const reason =
            full.decision?.targetMet && full.decision.targetCents != null && full.price
              ? `Meets your ${formatDollars(full.decision.targetCents)} all-in target (${formatDollars(full.price.totalCents)} est. total)${full.decision.priorities[0] ? ` and ${full.decision.priorities[0].toLowerCase()} priority` : ""}.`
              : `Checkout quote requested by shopper for ${full.product?.title ?? "cart item"}.`;

          return {
            activeItemId: full.id,
            needsCheckout: true,
            checkoutTarget: {
              itemId: full.id,
              offerId: chosenOffer.id,
              quantity: state.quantityHint ?? full.quantity,
              reason,
            },
          };
        }
      }
      // If cart didn't have the item yet (e.g. "Buy the AirFly Pro"), fall through to resolve & add it first!
    }

    // 8. Shopping / product resolution & add-to-cart + enrichment synthesis
    let chosenUrl: string | null = signals.urls[0] ?? null;
    let chosenVariant: string | undefined = state.variantHint ?? undefined;

    if (!chosenUrl && amazonContext?.liveOffers && amazonContext.liveOffers.length > 0) {
      const promptTerms = state.userPrompt
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w.length >= 3);
      const matchedLive = amazonContext.liveOffers.find((lo) =>
        promptTerms.some((term) => lo.title.toLowerCase().includes(term)),
      );
      if (matchedLive) {
        chosenUrl = matchedLive.url;
        if (!chosenVariant && matchedLive.variantLabel) {
          chosenVariant = matchedLive.variantLabel;
        }
      }
    }

    if (!chosenUrl) {
      const searchQuery =
        signals.categoryTopic === "headphones"
          ? "sony xm5 wireless headphones"
          : signals.categoryTopic === "bluetooth_transmitter"
            ? "airfly pro transmitter"
            : state.userPrompt;

      const catalogMatches: {
        offers: CartItemSnapshot["offers"];
      }[] = await ctx.runQuery(internal.chatAgent.internal.searchCatalog, {
        query: searchQuery,
      });

      if (catalogMatches.length > 0) {
        const top = catalogMatches[0];
        const filteredOffers = top.offers.filter((o: CartItemSnapshot["offers"][number]) => {
          if (state.retailerHint && o.retailer !== state.retailerHint) return false;
          if (
            state.variantHint &&
            o.variantLabel &&
            o.variantLabel.toLowerCase() !== state.variantHint.toLowerCase()
          ) {
            return false;
          }
          return true;
        });
        const candidatePool = filteredOffers.length > 0 ? filteredOffers : top.offers;
        const bestOffer = [...candidatePool].sort((a, b) => a.priceCents - b.priceCents)[0];
        if (bestOffer) {
          chosenUrl = bestOffer.url;
          chosenVariant = bestOffer.variantLabel ?? chosenVariant;
        }
      }
    }

    if (!chosenUrl) {
      const prefSummary = [
        state.targetCents != null ? `target ${formatDollars(state.targetCents)} all-in` : null,
        state.priorities.length > 0 ? state.priorities.join(", ") : null,
      ]
        .filter(Boolean)
        .join(" · ");

      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: `${prefSummary ? `Noted (${prefSummary}). ` : ""}Paste any Amazon, Best Buy, or retailer product URL (or browse in the Amazon sheet) and I'll add it to your cart with price history, cross-store reviews, Reddit feedback, and return terms.`,
        cards: [],
        threadStatus: "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_exec_${state.turnKey}`,
      });
      return { needsCheckout: false };
    }

    const reasonParts: string[] = [];
    if (state.priorities.length > 0) {
      reasonParts.push(state.priorities.join(", "));
    }
    if (state.targetCents != null) {
      reasonParts.push(`watching for ${formatDollars(state.targetCents)} ${state.targetAppliesTo === "item_price" ? "item" : "all-in"} target`);
    }
    const itemReason =
      reasonParts.length > 0 ? reasonParts.join("; ") : "Added via Cart Agent";

    const addKey = `agent_add_${threadId}_${chosenUrl}_${chosenVariant ?? "default"}`;
    const added = await ctx.runMutation(internal.agent.addItem, {
      shopperId,
      url: chosenUrl,
      variant: chosenVariant,
      reason: itemReason,
      quantity: state.quantityHint ?? 1,
      idempotencyKey: addKey,
    });

    if (state.priorities.length > 0 || state.targetCents !== null) {
      await ctx.runMutation(internal.chatAgent.internal.updateItemDecision, {
        shopperId,
        itemId: added.itemId,
        priorities: state.priorities,
        targetCents: state.targetCents ?? undefined,
        targetAppliesTo: state.targetCents !== null ? state.targetAppliesTo : undefined,
      });
    }

    const fullItem = await ensureItemEnriched(
      ctx,
      shopperId,
      added.itemId,
    );
    const updatedCart = (await ctx.runQuery(internal.agent.listItems, {
      shopperId,
    })) as CartItemSnapshot[];

    const clientActions: AmazonClientAction[] = [];
    if (fullItem.offer?.retailer === "amazon") {
      clientActions.push({
        type: "amazon_sync_cart_add",
        url: fullItem.offer.url,
        asin: extractAsinFromUrl(fullItem.offer.url),
        variantLabel: fullItem.variant?.label ?? fullItem.offer.variantLabel,
        quantity: fullItem.quantity,
      });
    }

    const prose = await synthesizeItemEvidenceText({
      userPrompt: state.userPrompt,
      item: fullItem,
      otherItems: updatedCart,
      amazonContext,
      wasJustAdded: true,
      priorMemories: state.recalledMemories,
    });

    const cards: AgentCard[] = [
      buildCartActionCard("added", fullItem, added.deduplicated),
      {
        kind: "product_evidence",
        itemId: fullItem.id,
        item: fullItem,
        featuredSection: signals.featuredSection,
      },
    ];

    const shouldProceedToCheckout = Boolean(
      (signals.intentKind === "checkout" || signals.alsoWantsCheckout) && fullItem.offer,
    );

    await persistAssistantTurn(
      {
        threadId,
        text: prose,
        cards,
        clientActions: clientActions.length > 0 ? clientActions : undefined,
        threadStatus: shouldProceedToCheckout ? "running" : "idle",
        activeClarificationId: null,
        lastError: null,
        idempotencyKey: `msg_added_${state.turnKey}`,
      },
      state.userPrompt,
    );

    if (shouldProceedToCheckout && fullItem.offer) {
      return {
        activeItemId: fullItem.id,
        needsCheckout: true,
        checkoutTarget: {
          itemId: fullItem.id,
          offerId: fullItem.offer.id,
          quantity: fullItem.quantity,
          reason: itemReason,
        },
      };
    }

    return {
      activeItemId: fullItem.id,
      needsCheckout: false,
      checkoutTarget: null,
    };
  };

  const prepareCheckout = async (state: typeof CartAgentState.State) => {
    const target = state.checkoutTarget!;
    const quoteRes = await ctx.runAction(internal.agent.requestPurchase, {
      shopperId,
      itemId: target.itemId as Id<"cartItems">,
      offerId: target.offerId as Id<"offers">,
      quantity: target.quantity,
      reason: target.reason,
      idempotencyKey: `agent_quote_${state.turnKey}_${target.itemId}`,
    });

    if (!quoteRes.quote) {
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: "Unable to lock a live quote from the retailer right now. Your item remains safe in Cart.",
        cards: [],
        threadStatus: "idle",
        pendingRequestId: null,
        lastError: null,
        idempotencyKey: `msg_quote_err_${state.turnKey}`,
      });
      return {
        needsCheckout: false,
        pendingCheckout: null,
      };
    }

    const q = quoteRes.quote;
    const amazonSignInRequired =
      q.retailer === "amazon" && amazonContext?.status === "signed_out";

    const approvalCard: CheckoutApprovalCard = {
      kind: "checkout_approval",
      requestId: quoteRes.requestId,
      itemId: target.itemId,
      offerId: target.offerId,
      quoteVersion: quoteRes.quoteVersion,
      expiresAt: quoteRes.expiresAt,
      status: "pending_approval",
      quote: q,
      reason: target.reason,
      amazonSignInRequired,
    };

    const clientActions: AmazonClientAction[] = amazonSignInRequired
      ? [
          {
            type: "amazon_prompt_sign_in",
            reason: `Sign in to Amazon before approving ${q.productTitle} (${formatDollars(q.totalCents)} total).`,
          },
        ]
      : [];

    const shippingLabel =
      q.shippingCents === 0 ? "free shipping" : `${formatDollars(q.shippingCents)} shipping`;
    const signInNote = amazonSignInRequired
      ? " Sign in to your Amazon session first, then approve below to place the order."
      : " Approve below to place the order, or keep it in Cart.";

    await persistAssistantTurn(
      {
        threadId,
        text: `Locked a ${q.retailerName} quote at ${formatDollars(q.totalCents)} total (${formatDollars(q.subtotalCents)} + ${formatDollars(q.taxCents)} tax, ${shippingLabel}).${signInNote}`,
        cards: [approvalCard],
        clientActions: clientActions.length > 0 ? clientActions : undefined,
        threadStatus: "awaiting_approval",
        activeClarificationId: null,
        pendingRequestId: quoteRes.requestId,
        lastError: null,
        idempotencyKey: `msg_quote_${state.turnKey}`,
      },
      state.userPrompt,
    );

    return {
      needsCheckout: false,
      pendingCheckout: {
        type: "await_checkout_approval" as const,
        requestId: quoteRes.requestId,
        itemId: target.itemId,
        offerId: target.offerId,
        quoteVersion: quoteRes.quoteVersion,
        expiresAt: quoteRes.expiresAt,
      },
    };
  };

  const awaitCheckoutApproval = async (state: typeof CartAgentState.State) => {
    const payload = state.pendingCheckout!;
    const resolution = interrupt<CheckoutInterruptPayload, CheckoutResumePayload>(payload);
    return {
      pendingCheckout: null,
      checkoutResolution: resolution,
    };
  };

  const finalizeCheckout = async (state: typeof CartAgentState.State) => {
    const resolution = state.checkoutResolution;
    if (!resolution) {
      await ctx.runMutation(internal.chatAgent.internal.setThreadState, {
        threadId,
        status: "idle",
        pendingRequestId: null,
        lastError: null,
      });
      return { checkoutResolution: null };
    }

    const reqStatus = await ctx.runQuery(internal.agent.getPurchaseStatus, {
      shopperId,
      requestId: resolution.requestId as Id<"purchaseRequests">,
    });

    if (
      resolution.decision === "approve" &&
      (resolution.outcome === "approved" || resolution.outcome === "already_approved") &&
      reqStatus.order &&
      reqStatus.quote
    ) {
      const receiptCard: OrderReceiptCard = {
        kind: "order_receipt",
        orderId: reqStatus.order.orderId,
        orderRef: reqStatus.order.orderRef,
        requestId: reqStatus.requestId,
        itemId: reqStatus.itemId,
        status: reqStatus.order.status,
        quote: reqStatus.quote,
        shipment: reqStatus.shipment,
        simulated: reqStatus.order.simulated,
      };
      const clientActions: AmazonClientAction[] =
        reqStatus.quote.retailer === "amazon" ? [{ type: "amazon_refresh_orders" }] : [];

      await persistAssistantTurn(
        {
          threadId,
          text: `Order placed (${reqStatus.order.orderRef}) for ${formatDollars(reqStatus.quote.totalCents)} total. Tracking updates live under Purchases.`,
          cards: [receiptCard],
          clientActions: clientActions.length > 0 ? clientActions : undefined,
          threadStatus: "idle",
          activeClarificationId: null,
          pendingRequestId: null,
          lastError: null,
          idempotencyKey: `msg_receipt_${reqStatus.order.orderId}`,
        },
        `Approved checkout (${reqStatus.order.orderRef})`,
      );
    } else if (resolution.decision === "defer" || resolution.outcome === "deferred") {
      await persistAssistantTurn(
        {
          threadId,
          text: "Kept it in your cart—no order was placed. Ask anytime when you want a fresh quote.",
          cards: [],
          threadStatus: "idle",
          activeClarificationId: null,
          pendingRequestId: null,
          lastError: null,
          idempotencyKey: `msg_defer_${resolution.requestId}`,
        },
        "Deferred checkout quote",
      );
    } else if (resolution.outcome === "expired") {
      await ctx.runMutation(internal.chatAgent.internal.appendAssistantMessage, {
        threadId,
        text: "That 30-minute quote expired before order placement, so nothing was charged. Say \"check out\" whenever you want a fresh quote.",
        cards: [],
        threadStatus: "idle",
        activeClarificationId: null,
        pendingRequestId: null,
        lastError: null,
        idempotencyKey: `msg_expired_${resolution.requestId}`,
      });
    } else {
      await ctx.runMutation(internal.chatAgent.internal.setThreadState, {
        threadId,
        status: "idle",
        pendingRequestId: null,
        lastError: null,
      });
    }

    return { checkoutResolution: null };
  };

  return new StateGraph(CartAgentState)
    .addNode("intake_router", intakeRouter)
    .addNode("build_clarification", buildClarification)
    .addNode("await_clarification", awaitClarification)
    .addNode("plan_and_execute", planAndExecute)
    .addNode("prepare_checkout", prepareCheckout)
    .addNode("await_checkout_approval", awaitCheckoutApproval)
    .addNode("finalize_checkout", finalizeCheckout)
    .addEdge(START, "intake_router")
    .addConditionalEdges(
      "intake_router",
      (state) => (state.needsClarification ? "build_clarification" : "plan_and_execute"),
      ["build_clarification", "plan_and_execute"],
    )
    .addEdge("build_clarification", "await_clarification")
    .addEdge("await_clarification", "plan_and_execute")
    .addConditionalEdges(
      "plan_and_execute",
      (state) => {
        if (state.needsCheckout && state.checkoutTarget) return "prepare_checkout";
        return END;
      },
      ["prepare_checkout", END],
    )
    .addEdge("prepare_checkout", "await_checkout_approval")
    .addEdge("await_checkout_approval", "finalize_checkout")
    .addEdge("finalize_checkout", END)
    .compile({ checkpointer });
}
