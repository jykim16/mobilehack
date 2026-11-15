/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agents from "../agents.js";
import type * as carts from "../carts.js";
import type * as http from "../http.js";
import type * as items from "../items.js";
import type * as lib_confidence from "../lib/confidence.js";
import type * as lib_demo from "../lib/demo.js";
import type * as lib_merchants from "../lib/merchants.js";
import type * as lib_scrape from "../lib/scrape.js";
import type * as users from "../users.js";
import type * as votes from "../votes.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agents: typeof agents;
  carts: typeof carts;
  http: typeof http;
  items: typeof items;
  "lib/confidence": typeof lib_confidence;
  "lib/demo": typeof lib_demo;
  "lib/merchants": typeof lib_merchants;
  "lib/scrape": typeof lib_scrape;
  users: typeof users;
  votes: typeof votes;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
