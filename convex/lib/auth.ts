import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";

export async function requireShopper(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<Id<"users">> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) {
    throw new ConvexError({ code: "UNAUTHENTICATED", message: "Sign in first." });
  }
  return userId;
}

export function notFound(what: string): never {
  throw new ConvexError({ code: "NOT_FOUND", message: `${what} not found.` });
}
