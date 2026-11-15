import { httpRouter } from "convex/server";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// MCP routes are mounted by convex/mcp/** (owned by the MCP thread), e.g.:
// import { registerMcpRoutes } from "./mcp/routes";
// registerMcpRoutes(http);

export default http;
