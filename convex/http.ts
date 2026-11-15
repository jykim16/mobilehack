import { httpRouter } from "convex/server";
import { auth } from "./auth";
import { registerMcpRoutes } from "./mcp/http";

const http = httpRouter();

auth.addHttpRoutes(http);

registerMcpRoutes(http);

export default http;
