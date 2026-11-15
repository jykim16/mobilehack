import { Doc } from "../_generated/dataModel";

export type Signal = {
  key: "deliberation" | "social" | "returns" | "price" | "rationale";
  label: string;
  score: number;
  max: number;
  detail: string;
};

export type Confidence = {
  score: number;
  signals: Signal[];
  hoursInCart: number;
  coolingOffRemainingHours: number;
  ready: boolean;
};

const DEFAULT_DELIBERATION_HOURS = 48;
export const READY_THRESHOLD = 70;

function formatHours(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

export function computeConfidence(
  item: Doc<"items">,
  votes: Doc<"votes">[],
  merchant: Doc<"merchants"> | null,
  now: number,
): Confidence {
  const hoursInCart = Math.max(0, (now - item.addedAt) / 3_600_000);
  const target = item.coolingOffHours ?? DEFAULT_DELIBERATION_HOURS;
  const coolingOffRemainingHours = item.coolingOffHours
    ? Math.max(0, item.coolingOffHours - hoursInCart)
    : 0;
  const deliberation: Signal = {
    key: "deliberation",
    label: "Time to think",
    max: 25,
    score: Math.round(25 * Math.min(1, hoursInCart / target)),
    detail: item.coolingOffHours
      ? coolingOffRemainingHours > 0
        ? `Cooling off: ${formatHours(coolingOffRemainingHours)} left of ${formatHours(item.coolingOffHours)}`
        : `Cooling-off period complete (${formatHours(item.coolingOffHours)})`
      : `In your cart for ${formatHours(hoursInCart)}`,
  };

  const ups = votes.filter((v) => v.value === 1).length;
  const downs = votes.length - ups;
  const certainty = Math.min(1, votes.length / 3);
  const positivity = (ups + 1) / (votes.length + 2);
  const social: Signal = {
    key: "social",
    label: "Friends",
    max: 25,
    score: Math.round(25 * (positivity * certainty + 0.4 * (1 - certainty))),
    detail:
      votes.length === 0
        ? "No votes yet. Share it to get a second opinion"
        : `${ups} 👍 · ${downs} 👎 from ${votes.length} friend${votes.length === 1 ? "" : "s"}`,
  };

  const returns: Signal = merchant
    ? {
        key: "returns",
        label: "Return policy",
        max: 20,
        score: Math.round(16 * Math.min(1, merchant.returnDays / 30) + (merchant.freeReturns ? 4 : 0)),
        detail: `${merchant.name}: ${merchant.returnDays}-day returns${merchant.freeReturns ? ", free" : ""}`,
      }
    : {
        key: "returns",
        label: "Return policy",
        max: 20,
        score: 6,
        detail: "Unknown merchant. Check the return policy before buying",
      };

  let price: Signal;
  if (item.price === undefined) {
    price = { key: "price", label: "Price", max: 15, score: 4, detail: "No price captured" };
  } else if (item.wasPrice && item.wasPrice > item.price) {
    const discount = 1 - item.price / item.wasPrice;
    price = {
      key: "price",
      label: "Price",
      max: 15,
      score: Math.round(15 * Math.min(1, 0.6 + discount * 2)),
      detail: `${Math.round(discount * 100)}% below the usual $${(item.wasPrice / 100).toFixed(2)}`,
    };
  } else {
    price = { key: "price", label: "Price", max: 15, score: 9, detail: "Regular price, no deal detected" };
  }

  let rationale: Signal;
  if (item.addedByKind === "user") {
    rationale = { key: "rationale", label: "Why it's here", max: 15, score: 15, detail: `You added this yourself` };
  } else {
    const r = item.rationale?.trim() ?? "";
    const alts = item.alternatives?.length ?? 0;
    const score = (r.length >= 40 ? 10 : r.length > 0 ? 6 : 0) + (alts > 0 ? 5 : 0);
    rationale = {
      key: "rationale",
      label: "Agent rationale",
      max: 15,
      score,
      detail: `${item.addedByName} explained ${r.length >= 40 ? "its reasoning" : "briefly"}${alts ? ` and compared ${alts} alternative${alts === 1 ? "" : "s"}` : ", no alternatives compared"}`,
    };
  }

  const signals = [deliberation, social, returns, price, rationale];
  const score = signals.reduce((s, x) => s + x.score, 0);
  return {
    score,
    signals,
    hoursInCart,
    coolingOffRemainingHours,
    ready: score >= READY_THRESHOLD && coolingOffRemainingHours === 0,
  };
}
