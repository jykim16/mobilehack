import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

/**
 * The deployed deployment already holds `shopperSubaccounts` rows written by the
 * payment work that reports the provider's own balances. Those rows must validate
 * against main's schema or no deployment from main can be pushed, so this pins the
 * exact shape a deployed row has.
 */
const DEPLOYED_ROW = {
  cardStatus: "none" as const,
  environment: "sandbox" as const,
  kycRequired: false,
  provider: "whop" as const,
  providerAccountId: "biz_5q9Kc1RhSBfKaa",
  providerAvailableCents: -1000.0,
  providerCurrency: "USD",
  providerFetchedAt: 1794793053380.0,
  providerPendingCents: 1826.0,
  status: "active" as const,
  updatedAt: 1794793053382.0,
  createdAt: 1794791085478.0,
};

describe("shopperSubaccounts compatibility with deployed payment rows", () => {
  test("a deployed row validates and reads back unmodified", async () => {
    const t = convexTest(schema, modules);
    const row = await t.run(async (ctx) => {
      const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
      const id = await ctx.db.insert("shopperSubaccounts", { ...DEPLOYED_ROW, shopperId });
      return await ctx.db.get("shopperSubaccounts", id);
    });
    expect(row).toMatchObject({
      providerAvailableCents: -1000,
      providerPendingCents: 1826,
      providerCurrency: "USD",
      providerFetchedAt: 1794793053380,
    });
  });

  test("rows written before the provider fields existed still validate", async () => {
    const t = convexTest(schema, modules);
    const row = await t.run(async (ctx) => {
      const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
      const id = await ctx.db.insert("shopperSubaccounts", {
        shopperId,
        provider: "whop",
        providerAccountId: "biz_legacy",
        environment: "sandbox",
        status: "active",
        kycRequired: true,
        cardStatus: "none",
        availableBalanceCents: 500,
        balanceCheckedAt: 1794700000000,
        createdAt: 1794700000000,
        updatedAt: 1794700000000,
      });
      return await ctx.db.get("shopperSubaccounts", id);
    });
    expect(row?.providerAvailableCents).toBeUndefined();
    expect(row?.availableBalanceCents).toBe(500);
  });
});
