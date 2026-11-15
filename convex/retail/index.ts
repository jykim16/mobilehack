import type { ActionCtx } from "../_generated/server";
import type { RetailerAdapter } from "./adapter";
import { SimulatedAmazonAdapter } from "./simulatedAmazon";

/**
 * Picks the adapter for a retailer. Register a live adapter here, e.g.
 *   if (retailer === "amazon" && process.env.AMAZON_LIVE === "1") return new LiveAmazonAdapter(ctx);
 * Everything else falls back to the clearly labeled simulated adapter.
 */
export function getAdapter(ctx: ActionCtx, _retailer: string): RetailerAdapter {
  return new SimulatedAmazonAdapter(ctx);
}
