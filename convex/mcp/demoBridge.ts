import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import { internalMutation, mutation, type MutationCtx } from "../_generated/server";
import { requireShopper } from "../lib/auth";

/**
 * A bearer token for the demo shopper lets Muse act before the app has a
 * "Connect an agent" screen. This moves that shopper's cart and pending
 * requests onto the signed-in shopper and repoints every demo connection token
 * at them, so the agent and the app share one cart and approvals land on stage.
 */

const DEMO_LOGIN = "demo";

type JoinResult = { movedItems: number; movedRequests: number; repointedTokens: number };

async function join(ctx: MutationCtx, shopperId: Id<"users">): Promise<JoinResult> {
  const demoShopperId: Id<"users"> | null = await ctx.runQuery(internal.mcp.store.demoShopper, { login: DEMO_LOGIN });
  if (!demoShopperId || demoShopperId === shopperId) return { movedItems: 0, movedRequests: 0, repointedTokens: 0 };

  const items = await ctx.db
    .query("cartItems")
    .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", demoShopperId))
    .take(50);
  let movedItems = 0;
  for (const item of items) {
    await ctx.db.patch("cartItems", item._id, { shopperId });
    const evidence = await ctx.db
      .query("evidence")
      .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", item._id))
      .take(10);
    for (const row of evidence) await ctx.db.patch("evidence", row._id, { shopperId });
    movedItems++;
  }

  const requests: { _id: Id<"purchaseRequests"> }[] = await ctx.db
    .query("purchaseRequests")
    .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", demoShopperId).eq("status", "pending_approval"))
    .take(50);
  for (const request of requests) await ctx.db.patch("purchaseRequests", request._id, { shopperId });

  const repointedTokens = await ctx.runMutation(internal.mcp.store.repointShopper, { from: demoShopperId, to: shopperId });
  return { movedItems, movedRequests: requests.length, repointedTokens };
}

/** App-side: "I'm the demo shopper" — adopt the demo cart and its agent connections. */
export const joinDemoShopper = mutation({
  args: {},
  handler: async (ctx) => join(ctx, await requireShopper(ctx)),
});

export const joinDemoShopperInternal = internalMutation({
  args: { shopperId: v.id("users") },
  handler: async (ctx, { shopperId }) => join(ctx, shopperId),
});
