import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";

function digits(seed: string, n: number) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = "";
  while (out.length < n) {
    h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
    out += String(h % 10);
  }
  return out;
}

export const place = internalMutation({
  args: { orderRef: v.string(), retailer: v.string() },
  handler: async (ctx, { orderRef, retailer }) => {
    const existing = await ctx.db
      .query("simulatedRetailerOrders")
      .withIndex("by_orderRef", (q) => q.eq("orderRef", orderRef))
      .unique();
    if (existing) return existing;
    const d = digits(orderRef, 17);
    const doc = {
      orderRef,
      retailer,
      retailerOrderId: `SIM-${d.slice(0, 3)}-${d.slice(3, 10)}-${d.slice(10, 17)}`,
      trackingNumber: `9400${digits(orderRef + "t", 18)}`,
      placedAt: Date.now(),
    };
    await ctx.db.insert("simulatedRetailerOrders", doc);
    return doc;
  },
});

export const get = internalQuery({
  args: { orderRef: v.string() },
  handler: async (ctx, { orderRef }) =>
    await ctx.db
      .query("simulatedRetailerOrders")
      .withIndex("by_orderRef", (q) => q.eq("orderRef", orderRef))
      .unique(),
});
