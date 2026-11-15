import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { addItemFor, getItemFor, listItemsFor } from "./model/cart";
import { loadOwnedRequest, requestPurchaseFor, requestView } from "./model/purchases";
import { requestPurchaseArgs } from "./purchases";

/**
 * Internal variants for the MCP layer. Call these only after authenticating
 * the agent's token and resolving it to a shopperId (see mcp/store.ts).
 * Every function enforces that the records belong to shopperId.
 */

export const addItem = internalMutation({
  args: {
    shopperId: v.id("users"),
    url: v.string(),
    variant: v.optional(v.string()),
    reason: v.optional(v.string()),
    quantity: v.optional(v.number()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, { shopperId, ...args }) => addItemFor(ctx, shopperId, args, "agent"),
});

export const listItems = internalQuery({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => listItemsFor(ctx, shopperId),
});

export const getItem = internalQuery({
  args: { shopperId: v.id("users"), itemId: v.id("cartItems") },
  handler: async (ctx, { shopperId, itemId }) => getItemFor(ctx, shopperId, itemId),
});

export const requestPurchase = internalAction({
  args: { shopperId: v.id("users"), ...requestPurchaseArgs },
  handler: async (ctx, { shopperId, ...args }) => requestPurchaseFor(ctx, shopperId, args, "agent"),
});

export const getPurchaseStatus = internalQuery({
  args: { shopperId: v.id("users"), requestId: v.id("purchaseRequests") },
  handler: async (ctx, { shopperId, requestId }) =>
    requestView(ctx, await loadOwnedRequest(ctx, shopperId, requestId)),
});
