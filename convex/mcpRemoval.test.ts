/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { ConvexError } from "convex/values";
import schema from "./schema";
import { internal } from "./_generated/api";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";

const modules = import.meta.glob("./**/*.ts");

async function seedCart() {
  const t = convexTest(schema, modules);
  const ids = await t.run(async (ctx) => {
    const shopperId = await ctx.db.insert("users", { name: "Shopper", isAnonymous: true });
    const otherId = await ctx.db.insert("users", { name: "Someone else", isAnonymous: true });
    const productId = await ctx.db.insert("products", { title: "Sony WH-1000XM5", category: "headphones" });
    const variantId = await ctx.db.insert("variants", { productId, label: "Black" });
    const offerId = await ctx.db.insert("offers", {
      productId,
      variantId,
      retailer: "amazon",
      retailerName: "Amazon",
      seller: "Amazon",
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      canonicalKey: "amazon:B09XS7JWHH",
      priceCents: 27999,
      shippingCents: 0,
      currency: "USD",
      deliveryEstimate: "3-5 days",
      returnSummary: "30 day returns",
      inStock: true,
      simulated: true,
      updatedAt: Date.now(),
    });
    const itemId = await ctx.db.insert("cartItems", {
      shopperId,
      url: "https://www.amazon.com/dp/B09XS7JWHH",
      productId,
      variantId,
      offerId,
      quantity: 1,
      addedBy: "agent",
      status: "active",
      enrichmentStatus: "ready",
      idempotencyKey: "agent-add-test",
      addedAt: Date.now(),
    });
    return { shopperId, otherId, itemId, offerId };
  });
  return { t, ...ids };
}

function pendingRequest(t: Awaited<ReturnType<typeof seedCart>>["t"], shopperId: Id<"users">, itemId: Id<"cartItems">, offerId: Id<"offers">, status: "pending_approval" | "approved" | "ordered") {
  return t.run(async (ctx) =>
    ctx.db.insert("purchaseRequests", {
      shopperId,
      cartItemId: itemId,
      offerId,
      quantity: 1,
      reason: "Test",
      requestedBy: "agent",
      idempotencyKey: "request-" + status,
      status,
      quoteVersion: 1,
      expiresAt: Date.now() + 60_000,
    }),
  );
}

describe("remove_cart_item", () => {
  test("removes an owned item and reports its title", async () => {
    const { t, shopperId, itemId } = await seedCart();
    const removed = await t.mutation(internal.mcp.removal.removeItem, { shopperId, itemId });
    expect(removed.title).toBe("Sony WH-1000XM5");
    const item = await t.run(async (ctx) => ctx.db.get("cartItems", itemId));
    expect(item?.status).toBe("removed");
  });

  test("another shopper's item is not found", async () => {
    const { t, otherId, itemId } = await seedCart();
    await expect(t.mutation(internal.mcp.removal.removeItem, { shopperId: otherId, itemId })).rejects.toMatchObject({
      data: { code: "NOT_FOUND" },
    });
  });

  test("a pending request is expired with the item", async () => {
    const { t, shopperId, itemId, offerId } = await seedCart();
    const requestId = await pendingRequest(t, shopperId, itemId, offerId, "pending_approval");
    await t.mutation(internal.mcp.removal.removeItem, { shopperId, itemId });
    const request = await t.run(async (ctx) => ctx.db.get("purchaseRequests", requestId));
    expect(request?.status).toBe("expired");
  });

  test("sees a blocking request past fifty older ones", async () => {
    const { t, shopperId, itemId, offerId } = await seedCart();
    await t.run(async (ctx) => {
      for (let i = 0; i < 60; i++) {
        await ctx.db.insert("purchaseRequests", {
          shopperId,
          cartItemId: itemId,
          offerId,
          quantity: 1,
          reason: `Noise ${i}`,
          requestedBy: "app",
          idempotencyKey: `noise-${i}`,
          status: "expired",
          quoteVersion: 1,
          expiresAt: Date.now() - 1000,
        });
      }
    });
    await pendingRequest(t, shopperId, itemId, offerId, "ordered");
    await expect(t.mutation(internal.mcp.removal.removeItem, { shopperId, itemId })).rejects.toMatchObject({
      data: { code: "INVALID_STATE" },
    });
  });

  test.each(["approved", "ordered"] as const)("refuses while the request is %s", async (status) => {
    const { t, shopperId, itemId, offerId } = await seedCart();
    await pendingRequest(t, shopperId, itemId, offerId, status);
    await expect(t.mutation(internal.mcp.removal.removeItem, { shopperId, itemId })).rejects.toBeInstanceOf(ConvexError);
    const item = await t.run(async (ctx) => ctx.db.get("cartItems", itemId));
    expect(item?.status).toBe("active");
  });
});
