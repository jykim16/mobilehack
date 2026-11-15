# Hackathon log

- **Project:** MobileCart
- **What it does:** A universal shopping cart that people and their AI agents fill from any store, with a per-item purchase confidence score built from deliberation time, friend votes, return policy, price context, and agent rationale.
- **Live app:** not deployed
- **Repo:** private
- **Frontend:** not deployed
- **Convex deployment:** not deployed
- **Components:** none
- **Convex features:** schema, tables, indexes, queries, mutations, actions, HTTP actions, realtime queries
- **Auth:** Other (anonymous device id)
- **AI models:** none
- **Started:** 2026-11-15T17:59:32Z
- **Last updated:** 2026-11-15T18:52:37Z

## Log

### 2026-11-15 - working tree
Created the Expo Router and TypeScript starter with Home and Explore screens
(`src/app/index.tsx`, `src/app/explore.tsx`, `src/app/_layout.tsx`). Added an empty
Convex schema (`convex/schema.ts`) and a development command; no tables or backend
functions exist yet. Fixed starter web-tab ref typing, CSS declarations, and web theme hydration
(`src/hooks/use-color-scheme.web.ts`).
There is no earlier product commit history; Started uses source-file time as weaker evidence.

### 2026-11-15 - working tree
Replaced the starter with the MobileCart app: a cart screen with per-item confidence rings and a
cart-level summary, item detail with a five-signal breakdown, agent rationale and alternatives,
cooling-off timer, friend votes and merchant return policy, an add-item flow that scrapes
OpenGraph tags from a pasted URL, share codes with a friend voting screen, and agent API key
management (src/app/, src/components/). Added the Convex backend: users, carts, items, votes,
merchants, and agents tables, confidence scoring, seeded demo data, and a POST /api/items HTTP
endpoint that lets an agent add an item with a hashed API key and a required rationale. Convex
features: schema, indexes, queries, mutations, actions, HTTP actions, realtime queries
(convex/schema.ts, convex/lib/confidence.ts, convex/http.ts, convex/items.ts).
