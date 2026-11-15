"use node";

import { ChatAnthropic } from "@langchain/anthropic";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";
import type { SectionName } from "../lib/validators";
import {
  enforceClarificationCap,
  type AmazonSessionContext,
  type CartItemSnapshot,
  type ClarificationAnswers,
  type ClarificationQuestion,
} from "./validators";

export type IntentKind =
  | "checkout"
  | "price_check"
  | "remove_item"
  | "set_quantity"
  | "update_decision"
  | "order_status"
  | "evidence_followup"
  | "shop";

export type CategoryTopic = "headphones" | "bluetooth_transmitter" | "general";

export type ShoppingSignals = {
  urls: string[];
  intentKind: IntentKind;
  alsoWantsCheckout: boolean;
  targetCents: number | null;
  budgetExplicit: boolean;
  targetAppliesTo: "all_in" | "item_price";
  priorities: string[];
  specificTradeoffExplicit: boolean;
  variantHint: string | null;
  retailerHint: "amazon" | "bestbuy" | null;
  quantity: number | null;
  featuredSection: SectionName;
  categoryTopic: CategoryTopic;
};

export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export function extractAsinFromUrl(url: string): string | undefined {
  const match = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  return match ? match[1].toUpperCase() : undefined;
}

export function resolveChatModel(): BaseChatModel | null {
  const openAiKey = process.env.OPENAI_API_KEY?.trim();
  if (openAiKey) {
    return new ChatOpenAI({
      apiKey: openAiKey,
      model: process.env.CART_AGENT_OPENAI_MODEL?.trim() || "gpt-4o-mini",
      temperature: 0.2,
      maxRetries: 1,
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (anthropicKey) {
    return new ChatAnthropic({
      apiKey: anthropicKey,
      model: process.env.CART_AGENT_ANTHROPIC_MODEL?.trim() || "claude-3-5-haiku-latest",
      temperature: 0.2,
      maxRetries: 1,
    });
  }

  return null;
}

export function parseBudgetFromText(text: string): {
  targetCents: number | null;
  budgetExplicit: boolean;
  targetAppliesTo: "all_in" | "item_price";
} {
  const lower = text.toLowerCase();
  const targetAppliesTo: "all_in" | "item_price" =
    /\b(before tax|pre[- ]tax|item price|sticker price)\b/.test(lower) ? "item_price" : "all_in";

  if (/\b(no strict cap|no budget|any budget|any price|money is no object|no cap)\b/.test(lower)) {
    return { targetCents: null, budgetExplicit: true, targetAppliesTo };
  }

  // Range like "$200-$250" or "$250–$350" -> upper bound is the cap
  const rangeMatch = text.match(/\$\s*(\d+(?:\.\d{1,2})?)\s*(?:[-–—]|to)\s*\$?\s*(\d+(?:\.\d{1,2})?)/i);
  if (rangeMatch) {
    const upper = Number(rangeMatch[2]);
    if (Number.isFinite(upper) && upper > 0) {
      return {
        targetCents: Math.round(upper * 100),
        budgetExplicit: true,
        targetAppliesTo,
      };
    }
  }

  // Explicit dollar amount like "$250", "under 250", "target 249.00"
  const dollarMatch =
    text.match(/\$\s*(\d+(?:\.\d{1,2})?)/) ??
    text.match(/\b(?:under|below|max|cap|budget|target|around)\s+(?:of\s+)?(\d{2,4}(?:\.\d{1,2})?)\b/i);
  if (dollarMatch) {
    const dollars = Number(dollarMatch[1]);
    if (Number.isFinite(dollars) && dollars > 0) {
      return {
        targetCents: Math.round(dollars * 100),
        budgetExplicit: true,
        targetAppliesTo,
      };
    }
  }

  return { targetCents: null, budgetExplicit: false, targetAppliesTo };
}

export function parsePrioritiesFromText(text: string): {
  priorities: string[];
  specificTradeoffExplicit: boolean;
} {
  const lower = text.toLowerCase();
  const priorities: string[] = [];
  let specificTradeoffExplicit = false;

  if (/\b(comfort|clamp|lightweight|ear[- ]?cup|plush|glasses|wear all day)\b/.test(lower)) {
    priorities.push("Comfort on long flights");
    specificTradeoffExplicit = true;
  }
  if (/\b(wired|3\.5\s*mm|aux|usb[- ]?c audio|passive|cable|seatback jack)\b/.test(lower)) {
    priorities.push("Wired listening and audio quality");
    specificTradeoffExplicit = true;
  }
  if (/\b(fold|folding|compact|case size|small case|onebag|under[- ]?seat|packable)\b/.test(lower)) {
    priorities.push("Compact folding case");
    specificTradeoffExplicit = true;
  }
  if (/\b(dual|two headphones|share audio|partner)\b/.test(lower)) {
    priorities.push("Dual-headphone sharing");
    specificTradeoffExplicit = true;
  }
  if (/\b(latency|lip[- ]?sync|video delay|aptX)\b/i.test(lower)) {
    priorities.push("Low video latency");
    specificTradeoffExplicit = true;
  }
  if (/\b(free return|return window|easy return)\b/.test(lower)) {
    priorities.push("Generous return window");
    specificTradeoffExplicit = true;
  }
  if (/\b(battery|16\+|30[- ]hour)\b/.test(lower)) {
    priorities.push("Long battery life");
    specificTradeoffExplicit = true;
  }

  return { priorities, specificTradeoffExplicit };
}

export function parseShoppingSignals(text: string): ShoppingSignals {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  const urls = Array.from(trimmed.matchAll(/https?:\/\/[^\s)>\]"']+/gi)).map((m) => m[0]);

  const { targetCents, budgetExplicit, targetAppliesTo } = parseBudgetFromText(trimmed);
  const { priorities, specificTradeoffExplicit } = parsePrioritiesFromText(trimmed);

  let variantHint: string | null = null;
  if (/\bsilver\b|\bplatinum\b/i.test(trimmed)) variantHint = "Silver";
  else if (/\bblack\b|\bmidnight\b/i.test(trimmed)) variantHint = "Black";

  let retailerHint: "amazon" | "bestbuy" | null = null;
  if (/\bbest\s*buy\b/i.test(trimmed)) retailerHint = "bestbuy";
  else if (/\bamazon\b/i.test(trimmed)) retailerHint = "amazon";

  let quantity: number | null = null;
  const qtyMatch =
    trimmed.match(/\b(?:quantity|qty)\s*(?:to|=|:)?\s*(\d{1,2})\b/i) ??
    trimmed.match(/\b(\d{1,2})\s+(?:pairs|units|items|of them)\b/i);
  if (qtyMatch) {
    const parsed = Number(qtyMatch[1]);
    if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 10) {
      quantity = parsed;
    }
  }

  let featuredSection: SectionName = "categoryGuidance";
  if (/\breturn|refund|exchange\b/.test(lower)) featuredSection = "returnTerms";
  else if (/\breddit|r\/\w+\b/.test(lower)) featuredSection = "reddit";
  else if (/\breviews?|ratings?|stars?\b/.test(lower)) featuredSection = "retailerReviews";
  else if (/\bprice|drop|history|low|cheap|cost\b/.test(lower)) featuredSection = "priceHistory";

  let categoryTopic: CategoryTopic = "general";
  if (/\b(airfly|transmitter|bluetooth adapter|dongle|seatback entertainment)\b/.test(lower)) {
    categoryTopic = "bluetooth_transmitter";
  } else if (/\b(headphone|anc|noise[- ]?cancel|xm5|xm4|sony|over[- ]?ear|earcup)\b/.test(lower)) {
    categoryTopic = "headphones";
  }

  const textWithoutStoreNames = trimmed.replace(/\bbest\s*buy\b/gi, "bestbuy_store");
  const checkoutRegex =
    /\b(check\s*out|checkout|buy(?:\s+it|\s+now|\s+the|\s+this|\s+them)?|purchase|place\s+(?:the\s+)?order|lock\s+(?:a\s+|an\s+|the\s+)?quote|get\s+(?:a\s+|me\s+a\s+)?quote|request\s+purchase|ready\s+to\s+buy)\b/i;
  const priceCheckRegex =
    /\b(price\s+history|price\s+drop|price\s+dropped|did\s+the\s+price|lowest\s+price|price\s+trend|check\s+(?:the\s+)?price|how\s+much\s+is\s+it\s+now)\b/i;
  const removeRegex = /\b(remove|delete|drop)\b.*\b(cart|sony|xm5|airfly|headphones|item)\b|\btake\s+it\s+out\b/i;
  const qtyVerbRegex = /\b(set|change|update|make)\s+(?:the\s+)?(?:quantity|qty)\b/i;
  const decisionUpdateRegex =
    /\b(set|change|update)\s+(?:my\s+|the\s+)?(?:target|budget|priorit(?:y|ies))\b/i;
  const orderStatusRegex =
    /\b(order\s+status|tracking|where\s+is\s+my\s+order|shipment|shipping\s+status|my\s+purchases)\b/i;
  const followupRegex =
    /\b(return\s+polic(?:y|ies)|return\s+window|return\s+terms|what\s+does\s+reddit|reddit\s+say|what(?:'s|\s+is)\s+in\s+my\s+cart|show\s+my\s+cart|hidden\s+tradeoffs?)\b|\bcompare\b.*\b(amazon|best\s*buy|stores?|retailers?|offers?|polic(?:y|ies))\b/i;

  const wantsCheckout = checkoutRegex.test(textWithoutStoreNames);
  const wantsPriceCheck = priceCheckRegex.test(trimmed);

  let intentKind: IntentKind = "shop";
  if (removeRegex.test(trimmed)) {
    intentKind = "remove_item";
  } else if (qtyVerbRegex.test(trimmed) && quantity !== null) {
    intentKind = "set_quantity";
  } else if (orderStatusRegex.test(trimmed)) {
    intentKind = "order_status";
  } else if (wantsPriceCheck) {
    intentKind = "price_check";
  } else if (wantsCheckout && urls.length === 0) {
    intentKind = "checkout";
  } else if (decisionUpdateRegex.test(trimmed) && urls.length === 0) {
    intentKind = "update_decision";
  } else if (followupRegex.test(trimmed) && urls.length === 0) {
    intentKind = "evidence_followup";
  } else {
    intentKind = "shop";
  }

  return {
    urls,
    intentKind,
    alsoWantsCheckout: wantsCheckout,
    targetCents,
    budgetExplicit,
    targetAppliesTo,
    priorities,
    specificTradeoffExplicit,
    variantHint,
    retailerHint,
    quantity,
    featuredSection,
    categoryTopic,
  };
}

export function mergeClarificationResolution(
  base: {
    targetCents: number | null;
    targetAppliesTo: "all_in" | "item_price";
    priorities: string[];
    variantHint: string | null;
    retailerHint: "amazon" | "bestbuy" | null;
  },
  resolution:
    | { kind: "answered"; answers: ClarificationAnswers }
    | { kind: "skipped"; answers?: ClarificationAnswers }
    | { kind: "freeform"; text: string },
): {
  targetCents: number | null;
  targetAppliesTo: "all_in" | "item_price";
  priorities: string[];
  variantHint: string | null;
  retailerHint: "amazon" | "bestbuy" | null;
} {
  const next = {
    targetCents: base.targetCents,
    targetAppliesTo: base.targetAppliesTo,
    priorities: [...base.priorities],
    variantHint: base.variantHint,
    retailerHint: base.retailerHint,
  };

  if (resolution.kind === "skipped") {
    return next;
  }

  if (resolution.kind === "freeform") {
    const parsed = parseShoppingSignals(resolution.text);
    if (parsed.budgetExplicit) {
      next.targetCents = parsed.targetCents;
      next.targetAppliesTo = parsed.targetAppliesTo;
    }
    for (const p of parsed.priorities) {
      if (!next.priorities.includes(p)) next.priorities.push(p);
    }
    if (parsed.variantHint) next.variantHint = parsed.variantHint;
    if (parsed.retailerHint) next.retailerHint = parsed.retailerHint;
    if (next.priorities.length === 0 && resolution.text.trim().length > 0 && !parsed.budgetExplicit) {
      next.priorities.push(resolution.text.trim().slice(0, 80));
    }
    return next;
  }

  for (const [key, rawValue] of Object.entries(resolution.answers)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const keyLower = key.toLowerCase();

    for (const val of values) {
      const trimmed = val.trim();
      if (!trimmed) continue;

      if (keyLower.includes("budget") || keyLower.includes("price")) {
        if (trimmed === "none" || trimmed === "any") {
          next.targetCents = null;
        } else if (/^\d+$/.test(trimmed)) {
          const num = Number(trimmed);
          // Values >= 1000 are integer cents (e.g. "25000" = $250.00); smaller numbers are dollars
          next.targetCents = num >= 1000 ? num : Math.round(num * 100);
        } else {
          const parsedBudget = parseBudgetFromText(trimmed);
          if (parsedBudget.budgetExplicit) {
            next.targetCents = parsedBudget.targetCents;
            next.targetAppliesTo = parsedBudget.targetAppliesTo;
          }
        }
        continue;
      }

      if (keyLower.includes("variant") || keyLower.includes("color")) {
        if (/silver/i.test(trimmed)) next.variantHint = "Silver";
        else if (/black/i.test(trimmed)) next.variantHint = "Black";
        else next.variantHint = trimmed;
        continue;
      }

      if (keyLower.includes("retailer") || keyLower.includes("store")) {
        if (/best\s*buy/i.test(trimmed)) next.retailerHint = "bestbuy";
        else if (/amazon/i.test(trimmed)) next.retailerHint = "amazon";
        continue;
      }

      if (!next.priorities.includes(trimmed)) {
        next.priorities.push(trimmed);
      }
    }
  }

  return next;
}

export function buildDeterministicClarification(signals: ShoppingSignals): {
  introText: string;
  questions: ClarificationQuestion[];
} {
  const questions: ClarificationQuestion[] = [];

  if (signals.categoryTopic === "headphones") {
    if (!signals.budgetExplicit) {
      questions.push({
        id: "budget",
        prompt: "What's your target all-in budget (including tax & shipping)?",
        kind: "price_range",
        allowFreeform: true,
        priceRangePreset: {
          minCents: 15000,
          maxCents: 40000,
          stepCents: 2500,
          defaultMaxCents: 25000,
          currency: "USD",
          appliesTo: "all_in",
        },
        options: [
          {
            id: "opt_budget_200",
            label: "Under $200",
            description: "Mid-range travel ANC",
            value: "20000",
          },
          {
            id: "opt_budget_250",
            label: "Under $250 all-in",
            description: "Flagship territory on sale",
            value: "25000",
          },
          {
            id: "opt_budget_350",
            label: "$250–$350",
            description: "Current flagship list price",
            value: "35000",
          },
          {
            id: "opt_budget_any",
            label: "No strict cap",
            description: "Show best overall",
            value: "none",
          },
        ],
      });
    }

    if (!signals.specificTradeoffExplicit) {
      questions.push({
        id: "priority",
        prompt: "Beyond noise cancelling, what matters more on flights?",
        kind: "single_select",
        allowFreeform: true,
        options: [
          {
            id: "opt_prio_comfort",
            label: "All-flight comfort",
            description: "Low clamp force & light ear-cup heat over 6+ hours",
            value: "Comfort on long flights",
          },
          {
            id: "opt_prio_wired",
            label: "Wired seatback audio",
            description: "3.5mm / USB-C DAC listening quality & passive mode",
            value: "Wired listening and audio quality",
          },
          {
            id: "opt_prio_fold",
            label: "Compact folding case",
            description: "Smallest footprint in an under-seat bag",
            value: "Compact folding case",
          },
        ],
      });
    }
  } else if (signals.categoryTopic === "bluetooth_transmitter") {
    if (!signals.budgetExplicit) {
      questions.push({
        id: "budget",
        prompt: "What's your target all-in budget for the flight adapter?",
        kind: "price_range",
        allowFreeform: true,
        priceRangePreset: {
          minCents: 2500,
          maxCents: 8000,
          stepCents: 500,
          defaultMaxCents: 6000,
          currency: "USD",
          appliesTo: "all_in",
        },
        options: [
          {
            id: "opt_budget_40",
            label: "Under $40",
            description: "Basic single-pair transmitter",
            value: "4000",
          },
          {
            id: "opt_budget_60",
            label: "Under $60 all-in",
            description: "Long-haul battery + dual pairing",
            value: "6000",
          },
          {
            id: "opt_budget_any",
            label: "No strict cap",
            description: "Best reliability for flights",
            value: "none",
          },
        ],
      });
    }

    if (!signals.specificTradeoffExplicit) {
      questions.push({
        id: "priority",
        prompt: "Which feature matters most for seatback audio?",
        kind: "single_select",
        allowFreeform: true,
        options: [
          {
            id: "opt_tx_battery",
            label: "16h+ long-haul battery",
            description: "Covers international flights on one charge",
            value: "Long battery life",
          },
          {
            id: "opt_tx_dual",
            label: "Dual-headphone sharing",
            description: "Pair two sets of headphones at once",
            value: "Dual-headphone sharing",
          },
          {
            id: "opt_tx_latency",
            label: "Low video latency",
            description: "Tighter lip-sync for movies",
            value: "Low video latency",
          },
        ],
      });
    }
  } else {
    if (!signals.budgetExplicit) {
      questions.push({
        id: "budget",
        prompt: "What's your target all-in budget (including tax & shipping)?",
        kind: "price_range",
        allowFreeform: true,
        priceRangePreset: {
          minCents: 5000,
          maxCents: 50000,
          stepCents: 2500,
          defaultMaxCents: 25000,
          currency: "USD",
          appliesTo: "all_in",
        },
        options: [
          {
            id: "opt_gen_100",
            label: "Under $100",
            description: "Value picks",
            value: "10000",
          },
          {
            id: "opt_gen_250",
            label: "Under $250 all-in",
            description: "Mid-to-flagship range",
            value: "25000",
          },
          {
            id: "opt_gen_400",
            label: "$250–$400",
            description: "Flagship tier",
            value: "40000",
          },
          {
            id: "opt_gen_any",
            label: "No strict cap",
            description: "Show best overall",
            value: "none",
          },
        ],
      });
    }

    if (!signals.specificTradeoffExplicit) {
      questions.push({
        id: "priority",
        prompt: "What matters most as I compare options and retailers?",
        kind: "single_select",
        allowFreeform: true,
        options: [
          {
            id: "opt_gen_price",
            label: "Lowest all-in price",
            description: "Track historical lows + tax & shipping",
            value: "Lowest all-in price",
          },
          {
            id: "opt_gen_reviews",
            label: "Top verified & Reddit reviews",
            description: "Prioritize long-term owner feedback",
            value: "Top verified reviews",
          },
          {
            id: "opt_gen_returns",
            label: "Generous free returns",
            description: "Longest hassle-free return window",
            value: "Generous return window",
          },
        ],
      });
    }
  }

  const capped = enforceClarificationCap(questions);
  const introText =
    capped.length === 1
      ? "Before I pull options into your cart, one quick check so I set the right target:"
      : "Before I pull options into your cart, two quick checks so I match the right pair and target price:";

  return { introText, questions: capped };
}

export async function generateClarificationQuestions(
  userPrompt: string,
  signals: ShoppingSignals,
  priorMemories: string[] = [],
): Promise<{ introText: string; questions: ClarificationQuestion[] }> {
  const deterministic = buildDeterministicClarification(signals);
  const model = resolveChatModel();
  if (!model) return deterministic;

  const memoryContext =
    priorMemories.length > 0
      ? `\nPrior shopper preferences (non-authoritative context only): ${priorMemories.join(" | ")}`
      : "";

  try {
    const response = await model.invoke([
      new SystemMessage(
        [
          "You generate concise structured shopping clarification questions in JSON.",
          "Ask 1 to 2 questions ideally, and NEVER more than 4 questions.",
          "All monetary amounts MUST be integer cents in USD (e.g., 25000 = $250.00).",
          "Return strict JSON: { \"introText\": string, \"questions\": ClarificationQuestion[] } where each question has:",
          "{ id: string, prompt: string, kind: \"single_select\" | \"multi_select\" | \"price_range\", allowFreeform: true, options: [{ id, label, description?, value }], priceRangePreset?: { minCents, maxCents, stepCents, defaultMaxCents?, currency: \"USD\", appliesTo: \"all_in\" | \"item_price\" } }.",
          "Include 2 to 4 options per question. Output JSON only.",
        ].join(" "),
      ),
      new HumanMessage(`Shopper request: ${userPrompt}${memoryContext}`),
    ]);

    const rawText =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonTextIsValid(jsonMatch?.[0])) return deterministic;

    const parsed = JSON.parse(jsonMatch![0]) as {
      introText?: unknown;
      questions?: unknown;
    };
    if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
      return deterministic;
    }

    const validQuestions: ClarificationQuestion[] = [];
    for (const q of parsed.questions.slice(0, 4)) {
      if (
        !q ||
        typeof q !== "object" ||
        typeof (q as Record<string, unknown>).id !== "string" ||
        typeof (q as Record<string, unknown>).prompt !== "string" ||
        !["single_select", "multi_select", "price_range"].includes(
          String((q as Record<string, unknown>).kind),
        ) ||
        !Array.isArray((q as Record<string, unknown>).options)
      ) {
        continue;
      }
      const qr = q as Record<string, unknown>;
      const opts = (qr.options as unknown[])
        .filter(
          (o): o is { id: string; label: string; description?: string; value: string } =>
            Boolean(o) &&
            typeof o === "object" &&
            typeof (o as Record<string, unknown>).id === "string" &&
            typeof (o as Record<string, unknown>).label === "string" &&
            typeof (o as Record<string, unknown>).value === "string",
        )
        .slice(0, 4);
      if (opts.length < 2) continue;

      let preset: ClarificationQuestion["priceRangePreset"] = undefined;
      if (qr.kind === "price_range" && qr.priceRangePreset && typeof qr.priceRangePreset === "object") {
        const pr = qr.priceRangePreset as Record<string, unknown>;
        if (
          typeof pr.minCents === "number" &&
          typeof pr.maxCents === "number" &&
          typeof pr.stepCents === "number"
        ) {
          preset = {
            minCents: Math.round(pr.minCents),
            maxCents: Math.round(pr.maxCents),
            stepCents: Math.round(pr.stepCents),
            defaultMaxCents:
              typeof pr.defaultMaxCents === "number" ? Math.round(pr.defaultMaxCents) : undefined,
            currency: "USD",
            appliesTo: pr.appliesTo === "item_price" ? "item_price" : "all_in",
          };
        }
      }

      validQuestions.push({
        id: qr.id as string,
        prompt: qr.prompt as string,
        kind: qr.kind as "single_select" | "multi_select" | "price_range",
        allowFreeform: true,
        options: opts,
        priceRangePreset: preset,
      });
    }

    if (validQuestions.length === 0) return deterministic;
    return {
      introText:
        typeof parsed.introText === "string" && parsed.introText.trim().length > 0
          ? parsed.introText.trim()
          : deterministic.introText,
      questions: enforceClarificationCap(validQuestions),
    };
  } catch {
    return deterministic;
  }
}

function jsonTextIsValid(raw: string | undefined): boolean {
  return typeof raw === "string" && raw.trim().startsWith("{") && raw.trim().endsWith("}");
}

export async function synthesizeItemEvidenceText(params: {
  userPrompt: string;
  item: CartItemSnapshot;
  otherItems: CartItemSnapshot[];
  amazonContext?: AmazonSessionContext;
  wasJustAdded: boolean;
  priorMemories?: string[];
}): Promise<string> {
  const { item, otherItems, amazonContext, wasJustAdded } = params;
  const title = item.product?.title ?? "this item";
  const variantText = item.variant?.label ? ` (${item.variant.label})` : "";
  const retailer = item.offer?.retailerName ?? "the retailer";
  const allInText = item.price ? `${formatDollars(item.price.totalCents)} est. all-in` : null;
  const itemPriceText = item.offer ? formatDollars(item.offer.priceCents) : null;

  const guidanceSection = item.sections.find((s) => s.section === "categoryGuidance");
  const newCriterion = guidanceSection?.highlights?.find((h) => h.tone === "new_criterion");
  const hasAirflyInCart = otherItems.some(
    (other) =>
      other.id !== item.id &&
      /airfly/i.test(`${other.product?.title ?? ""} ${other.url}`),
  );

  const parts: string[] = [];

  if (wasJustAdded) {
    const targetPhrase =
      item.decision?.targetCents != null
        ? ` with a ${formatDollars(item.decision.targetCents)} ${item.decision.targetAppliesTo === "item_price" ? "item-price" : "all-in"} target`
        : "";
    parts.push(`Saved ${title}${variantText} from ${retailer} to your cart${targetPhrase}.`);
  }

  if (item.rating) {
    const storeNames = Array.from(
      new Set(item.rating.retailers.map((r) => r.retailerName)),
    ).join(" + ");
    parts.push(
      `Rated ${item.rating.average}★ across ${item.rating.count.toLocaleString("en-US")} ${storeNames} reviews.`,
    );
  }

  if (newCriterion) {
    const airflyNote =
      hasAirflyInCart && /wired/i.test(newCriterion.label)
        ? " Your Best Buy AirFly Pro in Cart covers wireless seatback audio when needed."
        : "";
    parts.push(`Key tradeoff (${newCriterion.label}): ${newCriterion.detail}${airflyNote}`);
  }

  if (item.price && item.decision?.targetCents != null) {
    const target = item.decision.targetCents;
    const compareCents =
      item.decision.targetAppliesTo === "item_price"
        ? item.price.currentCents
        : item.price.totalCents;
    if (compareCents <= target) {
      parts.push(
        `At ${itemPriceText} (${allInText}), it meets your ${formatDollars(target)} target—say "check out" whenever you want a binding quote.`,
      );
    } else {
      const diff = compareCents - target;
      const lowNote =
        item.priceHistory && item.priceHistory.lowCents < item.price.currentCents
          ? ` (recent low: ${formatDollars(item.priceHistory.lowCents)})`
          : "";
      parts.push(
        `Right now it's ${allInText} (${formatDollars(diff)} above your ${formatDollars(target)} target)${lowNote}, so I'll hold it in Cart until the price drops or you ask to check out.`,
      );
    }
  } else if (itemPriceText && allInText) {
    parts.push(`Current price: ${itemPriceText} (${allInText}).`);
  }

  if (amazonContext?.liveOffers && amazonContext.liveOffers.length > 0 && item.offer?.retailer === "amazon") {
    const liveMatch = amazonContext.liveOffers.find(
      (lo) => lo.url === item.url || (lo.asin && item.url.includes(lo.asin)),
    );
    if (liveMatch) {
      parts.push(`Live Amazon session shows ${formatDollars(liveMatch.priceCents)}.`);
    }
  }

  const deterministicSummary = parts.join(" ");
  const model = resolveChatModel();
  if (!model) return deterministicSummary;

  const memoryPrefix =
    params.priorMemories && params.priorMemories.length > 0
      ? `Prior shopper memories (non-authoritative context; never alter prices or approve orders): ${params.priorMemories.join(" | ")}\n`
      : "";

  try {
    const res = await model.invoke([
      new SystemMessage(
        [
          "You are the Cart shopping assistant in a minimalist Shop-inspired mobile app.",
          "Rewrite the provided verified facts into 2-3 crisp, direct sentences.",
          "NEVER alter any dollar amount, review count, retailer name, or policy fact.",
          "Do not use emojis, greetings, or bullet lists.",
        ].join(" "),
      ),
      new HumanMessage(
        `${memoryPrefix}User asked: "${params.userPrompt}"\nVerified facts: ${deterministicSummary}`,
      ),
    ]);
    const content = typeof res.content === "string" ? res.content.trim() : "";
    return content.length > 20 ? content : deterministicSummary;
  } catch {
    return deterministicSummary;
  }
}
