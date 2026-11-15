// Unit tests for the condition rules: an unstated condition is purchasable; only
// an explicit used or refurbished offer is withheld.
import { classifyCondition, isPurchasableCondition, isWithheldCondition, offerConditionClass } from "../convex/lib/conditions.ts";

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`);
  if (!ok) failures++;
};

check("unstated condition is unknown", classifyCondition(null) === "unknown" && classifyCondition(undefined) === "unknown");
check("explicit New is new", classifyCondition("New") === "new" && classifyCondition("Brand New") === "new");
check("used wording is used", classifyCondition("Used: Like New") === "used" && classifyCondition("Pre-owned") === "used");
check("renewed wording is refurbished", classifyCondition("Certified Refurbished") === "refurbished" && classifyCondition("Renewed") === "refurbished");

check("a null-condition offer is purchasable", isPurchasableCondition({ condition: undefined }) && isPurchasableCondition({ condition: null }));
check("an unknown-condition offer is purchasable", isPurchasableCondition({ conditionClass: "unknown" }));
check("a new offer is purchasable", isPurchasableCondition({ condition: "New" }) && isPurchasableCondition({ conditionClass: "new" }));
check("a used offer is withheld", !isPurchasableCondition({ condition: "Used: Like New" }) && isWithheldCondition({ condition: "Used: Like New" }));
check("a refurbished offer is withheld", isWithheldCondition({ conditionClass: "refurbished" }));
check("no condition class falls back to the condition text", offerConditionClass({ condition: "Used - Very Good" }) === "used");

console.log(failures === 0 ? "\nALL CONDITION RULES PASS" : `\n${failures} CONDITION CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
