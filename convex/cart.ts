import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireShopper } from "./lib/auth";
import { targetAppliesTo } from "./lib/validators";
import {
  addItemFor,
  getItemFor,
  listItemsFor,
  removeItemFor,
  setQuantityFor,
  updateDecisionFor,
} from "./model/cart";

export const addItem = mutation({
  args: {
    url: v.string(),
    variant: v.optional(v.string()),
    reason: v.optional(v.string()),
    quantity: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => addItemFor(ctx, await requireShopper(ctx), args, "app"),
});

export const listItems = query({
  args: {},
  handler: async (ctx) => listItemsFor(ctx, await requireShopper(ctx)),
});

export const getItem = query({
  args: { itemId: v.id("cartItems") },
  handler: async (ctx, { itemId }) => getItemFor(ctx, await requireShopper(ctx), itemId),
});

export const updateDecision = mutation({
  args: {
    itemId: v.id("cartItems"),
    priorities: v.array(v.string()),
    targetCents: v.optional(v.number()),
    targetAppliesTo: v.optional(targetAppliesTo),
  },
  handler: async (ctx, args) => updateDecisionFor(ctx, await requireShopper(ctx), args),
});

export const setQuantity = mutation({
  args: { itemId: v.id("cartItems"), quantity: v.number() },
  handler: async (ctx, { itemId, quantity }) => setQuantityFor(ctx, await requireShopper(ctx), itemId, quantity),
});

export const removeItem = mutation({
  args: { itemId: v.id("cartItems") },
  handler: async (ctx, { itemId }) => removeItemFor(ctx, await requireShopper(ctx), itemId),
});
