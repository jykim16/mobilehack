import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";

/**
 * The only place the MCP layer talks to the cart backend. Every call passes the
 * shopperId resolved from the agent's token; the backend enforces ownership and
 * returns the same shapes iOS sees.
 */

export async function addItem(
  ctx: ActionCtx,
  shopperId: Id<"users">,
  args: { url: string; variant?: string; reason?: string; idempotencyKey: string },
) {
  return await ctx.runMutation(internal.agent.addItem, { shopperId, ...args });
}

export async function listItems(ctx: ActionCtx, shopperId: Id<"users">) {
  return await ctx.runQuery(internal.agent.listItems, { shopperId });
}

export async function getItem(ctx: ActionCtx, shopperId: Id<"users">, itemId: Id<"cartItems">) {
  return await ctx.runQuery(internal.agent.getItem, { shopperId, itemId });
}

export async function requestPurchase(
  ctx: ActionCtx,
  shopperId: Id<"users">,
  args: { itemId: Id<"cartItems">; offerId: Id<"offers">; quantity: number; reason: string; idempotencyKey: string },
) {
  return await ctx.runAction(internal.agent.requestPurchase, { shopperId, ...args });
}

export async function removeItem(ctx: ActionCtx, shopperId: Id<"users">, itemId: Id<"cartItems">) {
  return await ctx.runMutation(internal.agent.removeItem, { shopperId, cartItemId: itemId });
}

export async function getPurchaseStatus(ctx: ActionCtx, shopperId: Id<"users">, requestId: Id<"purchaseRequests">) {
  return await ctx.runQuery(internal.agent.getPurchaseStatus, { shopperId, requestId });
}
