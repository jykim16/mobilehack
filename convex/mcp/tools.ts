import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import { hashToken } from "../lib/tokens";
import * as backend from "./backend";

type JsonSchema = Record<string, unknown>;

export const TOOLS: { name: string; title: string; description: string; inputSchema: JsonSchema; annotations: Record<string, boolean> }[] = [
  {
    name: "add_cart_item",
    title: "Save to Cart",
    description:
      "Save a retailer product offer (an Amazon product URL) to the shopper's Cart. Cart resolves the exact offer and collects decision context: category guidance, return terms, price history, retailer reviews and Reddit. Returns the item ID and enrichment status; call get_cart_item to read the evidence as it lands.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Product page URL at the retailer." },
        variant: { type: "string", description: "Variant such as colour or size, if one was chosen." },
        reason: { type: "string", description: "Why you are suggesting this item; the shopper sees it." },
        idempotencyKey: { type: "string", description: "Optional. Repeat calls with the same key return the same item." },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "list_cart_items",
    title: "List Cart items",
    description: "List the shopper's Cart items with their saved offer, price, decision context and evidence section status.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_cart_item",
    title: "Get Cart item",
    description:
      "Read one Cart item in full: offers, price and all-in estimate, the shopper's priorities and target, and every evidence section (category guidance, return terms, price history, retailer reviews, Reddit) with its highlights, source links and checked time.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string", description: "Item ID from add_cart_item or list_cart_items." } },
      required: ["itemId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "remove_cart_item",
    title: "Remove from Cart",
    description:
      "Remove an item from the shopper's Cart. A pending purchase request on it is expired with it. If the shopper already approved or the order was placed, this refuses: tell the shopper to approve or cancel that purchase in the Cart app first.",
    inputSchema: {
      type: "object",
      properties: { itemId: { type: "string", description: "Cart item to remove." } },
      required: ["itemId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "request_purchase",
    title: "Request purchase approval",
    description:
      "Ask the shopper to approve buying a Cart item at a quote Cart resolves server-side. This buys nothing: it returns immediately with status pending_approval. Tell the shopper to open the Cart app to review the exact total and approve or defer, then check get_purchase_status.",
    inputSchema: {
      type: "object",
      properties: {
        itemId: { type: "string", description: "Cart item to buy." },
        offerId: { type: "string", description: "Offer to buy; defaults to the item's saved offer." },
        quantity: { type: "integer", minimum: 1, maximum: 10, default: 1 },
        reason: { type: "string", description: "Why you are asking for the purchase now; shown on the approval sheet." },
        idempotencyKey: { type: "string", description: "Optional. Repeat calls with the same key return the same request." },
      },
      required: ["itemId", "reason"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "get_purchase_status",
    title: "Get purchase status",
    description:
      "Check a purchase request: approval state (pending_approval, approved, deferred, expired, ordered, failed), its quote, order reference and limited shipment status.",
    inputSchema: {
      type: "object",
      properties: { requestId: { type: "string", description: "Request ID from request_purchase." } },
      required: ["requestId"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export class ToolInputError extends Error {}

const PENDING_MESSAGE =
  "Purchase request sent; nothing has been bought. Ask the shopper to open the Cart app, review the exact quote and approve or defer, then check back with get_purchase_status.";

const PRIVATE_KEYS = /^(payment|card|billing|shippingaddress|shippingto|address\w*|street|postal|zip|phone|recipient|tokenHash|clientId|tokenIdentifier)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k.startsWith("_") || PRIVATE_KEYS.test(k)) continue;
      out[k] = redact(v);
    }
    return out;
  }
  return value;
}

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false) {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolInputError(`Missing required argument: ${key}`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolInputError(`Argument ${key} must be a string`);
  return value;
}

function backendMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    const data = err.data as { code?: string; message?: string } | undefined;
    if (data?.code === "NOT_FOUND") return "Nothing with that ID belongs to this shopper.";
    if (data?.message) return data.message;
  }
  return "Cart could not complete that request.";
}

/** Cart's item id is `id`; agents get it as `itemId` to match the tool contract. */
function asItem<T extends { id: string }>(item: T) {
  return { itemId: item.id, ...item };
}

export async function callTool(ctx: ActionCtx, shopperId: Id<"users">, name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "add_cart_item": {
      const url = str(args, "url", true);
      const variant = str(args, "variant");
      const explicitKey = str(args, "idempotencyKey");
      if (!explicitKey) {
        const existing = (await backend.listItems(ctx, shopperId)).find(
          (candidate) =>
            candidate.url === url &&
            (variant === undefined || candidate.variant?.label.toLowerCase() === variant.toLowerCase()),
        );
        if (existing) return { ...asItem(existing), deduplicated: true };
      }
      // Deterministic so two concurrent adds of the same offer collapse in the backend's own lookup.
      // After an item is removed, pass a fresh idempotencyKey to add it again.
      const idempotencyKey = explicitKey ?? (await hashToken(`add:${shopperId}:${url}:${variant ?? ""}`));
      return await backend.addItem(ctx, shopperId, { url, variant, reason: str(args, "reason"), idempotencyKey });
    }
    case "list_cart_items": {
      const items = await backend.listItems(ctx, shopperId);
      return { items: items.map(asItem) };
    }
    case "get_cart_item": {
      const item = await backend.getItem(ctx, shopperId, str(args, "itemId", true) as Id<"cartItems">);
      if (!item) throw new ToolInputError("No Cart item with that ID for this shopper.");
      return asItem(item);
    }
    case "request_purchase": {
      const itemId = str(args, "itemId", true) as Id<"cartItems">;
      const quantity = args.quantity === undefined ? 1 : args.quantity;
      if (typeof quantity !== "number" || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
        throw new ToolInputError("quantity must be an integer from 1 to 10");
      }
      const reason = str(args, "reason", true);
      const item = await backend.getItem(ctx, shopperId, itemId);
      if (!item) throw new ToolInputError("No Cart item with that ID for this shopper.");
      const offerId = (str(args, "offerId") ?? item.offer?.id) as Id<"offers"> | undefined;
      if (!offerId) throw new ToolInputError("This Cart item has no resolved offer yet; try again once enrichment finishes.");
      // Retries of a live request dedupe on its own key; a new request needs a new key.
      if (!str(args, "idempotencyKey") && item.pendingRequest) {
        const live = await backend.getPurchaseStatus(ctx, shopperId, item.pendingRequest.requestId);
        return { ...live, message: PENDING_MESSAGE };
      }
      const idempotencyKey = str(args, "idempotencyKey") ?? `agent-purchase-${crypto.randomUUID()}`;
      const request = await backend.requestPurchase(ctx, shopperId, { itemId, offerId, quantity, reason, idempotencyKey });
      return { ...request, message: PENDING_MESSAGE };
    }
    case "remove_cart_item": {
      const itemId = str(args, "itemId", true) as Id<"cartItems">;
      const item = await backend.getItem(ctx, shopperId, itemId);
      if (!item) throw new ToolInputError("No Cart item with that ID for this shopper.");
      await backend.removeItem(ctx, shopperId, itemId);
      return { removed: true, itemId, title: item.product?.title ?? item.url };
    }
    case "get_purchase_status":
      return await backend.getPurchaseStatus(ctx, shopperId, str(args, "requestId", true) as Id<"purchaseRequests">);
    default:
      throw new ToolInputError(`Unknown tool: ${name}`);
  }
}

export { backendMessage };
