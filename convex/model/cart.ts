import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { canonicalKeyForUrl } from "../lib/urls";
import { notFound } from "../lib/auth";
import { cartItemView } from "./views";

export type AddItemArgs = {
  url: string;
  variant?: string;
  reason?: string;
  quantity?: number;
  idempotencyKey: string;
};

export async function addItemFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  args: AddItemArgs,
  addedBy: "app" | "agent",
) {
  const existing = await ctx.db
    .query("cartItems")
    .withIndex("by_shopperId_and_idempotencyKey", (q) =>
      q.eq("shopperId", shopperId).eq("idempotencyKey", args.idempotencyKey),
    )
    .unique();
  if (existing) {
    return { itemId: existing._id, enrichmentStatus: existing.enrichmentStatus, deduplicated: true };
  }

  const canonicalKey = canonicalKeyForUrl(args.url);
  if (!canonicalKey) {
    throw new ConvexError({ code: "INVALID_URL", message: "url must be an http(s) product link." });
  }
  const quantity = args.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new ConvexError({ code: "INVALID_QUANTITY", message: "quantity must be 1-10." });
  }

  let offer = await ctx.db
    .query("offers")
    .withIndex("by_canonicalKey", (q) => q.eq("canonicalKey", canonicalKey))
    .first();
  if (offer && args.variant) {
    const wanted = args.variant.trim().toLowerCase();
    const siblings = await ctx.db
      .query("offers")
      .withIndex("by_productId", (q) => q.eq("productId", offer!.productId))
      .take(20);
    for (const o of siblings) {
      if (o.retailer !== offer.retailer) continue;
      const vdoc = await ctx.db.get("variants", o.variantId);
      if (vdoc && vdoc.label.toLowerCase() === wanted) {
        offer = o;
        break;
      }
    }
  }

  const itemId = await ctx.db.insert("cartItems", {
    shopperId,
    url: args.url.trim(),
    productId: offer?.productId,
    variantId: offer?.variantId,
    offerId: offer?._id,
    quantity,
    reason: args.reason,
    addedBy,
    status: "active",
    enrichmentStatus: offer ? "enriching" : "resolving",
    idempotencyKey: args.idempotencyKey,
    addedAt: Date.now(),
  });

  if (offer) {
    await ctx.scheduler.runAfter(0, internal.enrichment.start, { cartItemId: itemId });
  } else {
    await ctx.scheduler.runAfter(0, internal.enrichment.resolveOffer, { cartItemId: itemId });
  }
  return { itemId, enrichmentStatus: offer ? ("enriching" as const) : ("resolving" as const), deduplicated: false };
}

export async function loadOwnedItem(ctx: QueryCtx, shopperId: Id<"users">, itemId: Id<"cartItems">) {
  const item = await ctx.db.get("cartItems", itemId);
  if (!item || item.shopperId !== shopperId || item.status === "removed") notFound("Cart item");
  return item;
}

export async function listItemsFor(ctx: QueryCtx, shopperId: Id<"users">) {
  const items = await ctx.db
    .query("cartItems")
    .withIndex("by_shopperId_and_status", (q) => q.eq("shopperId", shopperId).eq("status", "active"))
    .order("desc")
    .take(100);
  return await Promise.all(items.map((i) => cartItemView(ctx, i, "summary")));
}

export async function getItemFor(ctx: QueryCtx, shopperId: Id<"users">, itemId: Id<"cartItems">) {
  const item = await loadOwnedItem(ctx, shopperId, itemId);
  return await cartItemView(ctx, item, "full");
}

export async function updateDecisionFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  args: {
    itemId: Id<"cartItems">;
    priorities: string[];
    targetCents?: number;
    targetAppliesTo?: "item_price" | "all_in";
  },
) {
  await loadOwnedItem(ctx, shopperId, args.itemId);
  if (args.targetCents !== undefined && (!Number.isInteger(args.targetCents) || args.targetCents <= 0)) {
    throw new ConvexError({ code: "INVALID_TARGET", message: "targetCents must be a positive integer." });
  }
  const decision = {
    priorities: args.priorities.slice(0, 20),
    targetCents: args.targetCents,
    targetAppliesTo: args.targetCents !== undefined ? (args.targetAppliesTo ?? "all_in") : args.targetAppliesTo,
    updatedAt: Date.now(),
  };
  await ctx.db.patch("cartItems", args.itemId, { decision });
  return decision;
}

export async function setQuantityFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  itemId: Id<"cartItems">,
  quantity: number,
) {
  await loadOwnedItem(ctx, shopperId, itemId);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw new ConvexError({ code: "INVALID_QUANTITY", message: "quantity must be 1-10." });
  }
  await ctx.db.patch("cartItems", itemId, { quantity });
  return null;
}

export async function removeItemFor(
  ctx: MutationCtx,
  shopperId: Id<"users">,
  itemId: Id<"cartItems">,
) {
  const item = await loadOwnedItem(ctx, shopperId, itemId);

  for (const status of ["approved", "ordered"] as const) {
    const committed = await ctx.db
      .query("purchaseRequests")
      .withIndex("by_cartItemId_and_status", (q) => q.eq("cartItemId", itemId).eq("status", status))
      .first();
    if (committed || item.status === "purchased") {
      throw new ConvexError({
        code: "INVALID_STATE",
        message: "This item is already being purchased; it can't be removed.",
      });
    }
  }
  for (const status of ["pending_approval", "quoting"] as const) {
    const live = await ctx.db
      .query("purchaseRequests")
      .withIndex("by_cartItemId_and_status", (q) => q.eq("cartItemId", itemId).eq("status", status))
      .take(20);
    for (const r of live) {
      await ctx.db.patch("purchaseRequests", r._id, {
        status: "expired",
        error: "The cart item was removed.",
      });
    }
  }

  const evidence = await ctx.db
    .query("evidence")
    .withIndex("by_cartItemId_and_section", (q) => q.eq("cartItemId", itemId))
    .take(20);
  for (const e of evidence) await ctx.db.delete("evidence", e._id);

  const comparisons = await ctx.db
    .query("priceComparisons")
    .withIndex("by_cartItemId", (q) => q.eq("cartItemId", itemId))
    .take(10);
  for (const c of comparisons) await ctx.db.delete("priceComparisons", c._id);

  if (item.offerId) {
    const offerId = item.offerId;
    const siblings = await ctx.db
      .query("cartItems")
      .withIndex("by_offerId_and_status", (q) => q.eq("offerId", offerId))
      .take(50);
    const shared = siblings.some((s) => s._id !== itemId && s.status !== "removed");
    if (!shared) {
      const observations = await ctx.db
        .query("priceObservations")
        .withIndex("by_offerId_and_observedAt", (q) => q.eq("offerId", offerId))
        .take(500);
      for (const o of observations) await ctx.db.delete("priceObservations", o._id);
    }
  }

  const product = item.productId ? await ctx.db.get("products", item.productId) : null;
  const title = product?.title ?? item.url;

  await ctx.db.delete("cartItems", itemId);
  return { removed: true as const, title };
}
