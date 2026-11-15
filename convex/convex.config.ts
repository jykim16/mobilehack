import { defineApp } from "convex/server";
import { v } from "convex/values";

/**
 * App-level environment declarations. Declaring a variable here makes it visible
 * to functions through `env` from `./_generated/server`; values are still set per
 * deployment with `npx convex env set` and never committed.
 */
const app = defineApp({
  env: {
    FIRECRAWL_API_KEY: v.optional(v.string()),
  },
});

export default app;
