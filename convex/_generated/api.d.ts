/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as agent from "../agent.js";
import type * as auth from "../auth.js";
import type * as cart from "../cart.js";
import type * as demo from "../demo.js";
import type * as enrichment from "../enrichment.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_demoData from "../lib/demoData.js";
import type * as lib_opengraph from "../lib/opengraph.js";
import type * as lib_tokens from "../lib/tokens.js";
import type * as lib_urls from "../lib/urls.js";
import type * as lib_validators from "../lib/validators.js";
import type * as mcp_backend from "../mcp/backend.js";
import type * as mcp_connection from "../mcp/connection.js";
import type * as mcp_crypto from "../mcp/crypto.js";
import type * as mcp_demoBridge from "../mcp/demoBridge.js";
import type * as mcp_http from "../mcp/http.js";
import type * as mcp_store from "../mcp/store.js";
import type * as mcp_tables from "../mcp/tables.js";
import type * as mcp_tools from "../mcp/tools.js";
import type * as model_cart from "../model/cart.js";
import type * as model_purchases from "../model/purchases.js";
import type * as model_views from "../model/views.js";
import type * as orders from "../orders.js";
import type * as purchases from "../purchases.js";
import type * as retail_adapter from "../retail/adapter.js";
import type * as retail_index from "../retail/index.js";
import type * as retail_pricing from "../retail/pricing.js";
import type * as retail_simulatedAmazon from "../retail/simulatedAmazon.js";
import type * as retail_simulatedStore from "../retail/simulatedStore.js";
import type * as reviews from "../reviews.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  agent: typeof agent;
  auth: typeof auth;
  cart: typeof cart;
  demo: typeof demo;
  enrichment: typeof enrichment;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/demoData": typeof lib_demoData;
  "lib/opengraph": typeof lib_opengraph;
  "lib/tokens": typeof lib_tokens;
  "lib/urls": typeof lib_urls;
  "lib/validators": typeof lib_validators;
  "mcp/backend": typeof mcp_backend;
  "mcp/connection": typeof mcp_connection;
  "mcp/crypto": typeof mcp_crypto;
  "mcp/demoBridge": typeof mcp_demoBridge;
  "mcp/http": typeof mcp_http;
  "mcp/store": typeof mcp_store;
  "mcp/tables": typeof mcp_tables;
  "mcp/tools": typeof mcp_tools;
  "model/cart": typeof model_cart;
  "model/purchases": typeof model_purchases;
  "model/views": typeof model_views;
  orders: typeof orders;
  purchases: typeof purchases;
  "retail/adapter": typeof retail_adapter;
  "retail/index": typeof retail_index;
  "retail/pricing": typeof retail_pricing;
  "retail/simulatedAmazon": typeof retail_simulatedAmazon;
  "retail/simulatedStore": typeof retail_simulatedStore;
  reviews: typeof reviews;
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
