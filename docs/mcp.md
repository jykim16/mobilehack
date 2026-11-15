# Cart MCP server

Personal agents (Muse, ChatGPT) shop through Cart over a remote MCP server hosted by the Convex deployment.

- Endpoint: `https://<deployment>.convex.site/mcp` — Streamable HTTP, stateless JSON-RPC (`initialize`, `tools/list`, `tools/call`, `ping`).
- Auth: OAuth 2.1. Discovery at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamic client registration at `/oauth/register`, authorize at `/oauth/authorize` (authorization code + PKCE S256), token at `/oauth/token` with refresh rotation. Agents that only accept a key use a `cart_ct_` bearer token instead.

## Tools
| Tool | Does |
|---|---|
| `add_cart_item` | Saves a retailer product URL to the shopper's Cart and starts enrichment; returns `itemId` + status. |
| `list_cart_items` | Lists active items with offer, price, decision context and section status. |
| `get_cart_item` | One item in full: offers, all-in estimate, priorities and target, every evidence section with highlights, source links and checked time. |
| `request_purchase` | Asks the shopper to approve a purchase. Returns immediately with `pending_approval`; buys nothing. |
| `get_purchase_status` | Approval state, quote, order reference and shipment status. |

Inputs and outputs match the iOS client shapes, with `itemId` aliasing the cart item `id`. Payment, card, billing, address and phone fields are stripped before a response leaves the server. Every call is scoped to the shopper whose token authenticated it, and approval only ever happens in the signed-in app.

## Pairing
The OAuth page asks for a pairing code the app mints with `api.mcp.connection.createPairingCode` (10 minutes, single use). `demo` maps to the demo shopper for the stage run. `api.mcp.connection.createConnection` mints a bearer token instead, and `listConnections` / `revokeConnection` manage them.

## Verification
```bash
node scripts/mcp-smoke.mjs https://<deployment>.convex.site              # OAuth path, then every tool
MCP_TOKEN=cart_ct_... node scripts/mcp-smoke.mjs https://<deployment>.convex.site   # bearer path
```
