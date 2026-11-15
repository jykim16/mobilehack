export type ConditionClass = "new" | "used" | "refurbished" | "unknown";

/**
 * Retailer condition strings are free text ("New", "Used: Like New",
 * "Certified Refurbished"). Only an explicitly new offer may be presented as the
 * item; anything else is stored and labeled.
 */
export function classifyCondition(condition: string | null | undefined): ConditionClass {
  if (!condition) return "unknown";
  const c = condition.toLowerCase();
  if (c.includes("refurb") || c.includes("renew") || c.includes("certified pre")) return "refurbished";
  if (
    c.includes("used") ||
    c.includes("pre-owned") ||
    c.includes("preowned") ||
    c.includes("open box") ||
    c.includes("open-box") ||
    c.includes("like new") ||
    c.includes("very good") ||
    c.includes("acceptable")
  ) {
    return "used";
  }
  if (c.includes("new")) return "new";
  return "unknown";
}

export function offerConditionClass(offer: { condition?: string; conditionClass?: ConditionClass }): ConditionClass {
  return offer.conditionClass ?? classifyCondition(offer.condition);
}

/**
 * Only an explicitly used or refurbished offer is withheld. An unstated
 * condition is unknown, not disqualifying: most retailer Buy Boxes never print
 * the word "New".
 */
export function isWithheldCondition(offer: { condition?: string; conditionClass?: ConditionClass }): boolean {
  const cls = offerConditionClass(offer);
  return cls === "used" || cls === "refurbished";
}

export function isPurchasableCondition(offer: { condition?: string; conditionClass?: ConditionClass }): boolean {
  return !isWithheldCondition(offer);
}
