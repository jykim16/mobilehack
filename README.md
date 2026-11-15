# MobileCart

One cart for every store, filled by you and your AI agents. Agentic shopping makes buying effortless, which also strips away the moments that make you confident in a purchase. MobileCart puts them back: every item gets a **confidence score (0-100)** built from five signals.

| Signal | Max | What raises it |
|---|---|---|
| Time to think | 25 | Time in cart, or progress through an optional cooling-off timer (24h / 3d / 1w) |
| Friends | 25 | Thumbs up/down votes from friends you share the cart with (real time via Convex) |
| Return policy | 20 | The merchant's return window and free returns (seeded for Amazon, Target, Nike, Apple, Best Buy, Walmart, Costco, IKEA, REI and more) |
| Price | 15 | A "was" price above the current price (deal) |
| Rationale | 15 | You added it yourself, or the agent explained why and listed alternatives |

An item is **Ready to buy** when its score is at least 70 and its cooling-off timer has finished. The scoring lives in [`convex/lib/confidence.ts`](convex/lib/confidence.ts).

## Stack

- Expo SDK 58, Expo Router, TypeScript. The app lives at the repository root; routes are in `src/app/`.
- Convex for data, real-time votes, the OpenGraph scraper action, and the agent HTTP API.
- Auth is an anonymous device id stored in AsyncStorage. The first launch creates a user, a cart, and a seeded demo cart with friend votes and agent picks.

Screens: Cart (`/`), Item detail (`/item/[id]`), Add item (`/add`, paste a URL to auto-fill title, price, and image), Ask friends (`/share`), Friend voting (`/s/[code]`), Agents and API keys (`/agents`), and a Pro paywall placeholder (`/paywall`).

## Run it

```sh
npm ci
npx convex dev          # first run: log in and pick or create a project; writes EXPO_PUBLIC_CONVEX_URL to .env.local
npm start               # in a second terminal; scan the QR code with Expo Go, or press w for web
```

Without a Convex account you can develop locally with `CONVEX_AGENT_MODE=anonymous npx convex dev`. That backend runs on 127.0.0.1, so a phone can't reach it; use a cloud dev deployment for device demos.

`EXPO_PUBLIC_CONVEX_URL` (and `EXPO_PUBLIC_CONVEX_SITE_URL`, used to show the API URL in the app) are read at build time, so set them in the environment for Revyl or EAS builds.

Deploy functions without the watcher, for example in CI:

```sh
CONVEX_DEPLOY_KEY=... npx convex deploy
```

## Agent API

An agent adds items to your cart with an API key. Create one in the app: Cart → ✦ (Agents) → Create API key. Keys are stored hashed and shown once.

`POST https://<deployment>.convex.site/api/items`

| Field | Required | Notes |
|---|---|---|
| `url` | yes | Product page. Missing title, price, or image are scraped from its OpenGraph tags |
| `rationale` | yes | Why the agent picked it; shown as "Added by <agent> because ..." |
| `title`, `price`, `wasPrice`, `imageUrl` | no | Prices in dollars |
| `alternatives` | no | `[{ title, price?, url?, reason? }]`, up to 5 |
| `coolingOffHours` | no | Start a cooling-off timer |

```sh
curl -X POST "$EXPO_PUBLIC_CONVEX_SITE_URL/api/items" \
  -H "Authorization: Bearer uc_your_key_here" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://www.rei.com/product/123",
    "title": "REI Half Dome 2 Tent",
    "price": 279.95,
    "wasPrice": 349.95,
    "rationale": "You booked Yosemite for May. This is REI'\''s best-selling 2-person tent and weighs under 5 lbs.",
    "alternatives": [{ "title": "MSR Hubba Hubba", "price": 499.95, "reason": "Lighter, but $220 more" }]
  }'
# => {"ok":true,"itemId":"...","title":"REI Half Dome 2 Tent","addedBy":"Claude Shopper"}
```

Errors: `401` for a missing or invalid key, `400` for a missing `url` or `rationale`.

## Pro seam

`users.isPro` is the Pro flag, read in the app with `useIsPro()` from `src/lib/session.tsx`. Free users can connect two agents; the third opens `/paywall`, a placeholder for the Whop checkout. A webhook should flip `isPro` (see `users.setPro`, which should become internal once payments are wired).

## Checks

```sh
npm run typecheck
npm run lint
npx convex dev --once   # pushes functions and typechecks convex/
npx expo export --platform web
```

## Revyl

`.revyl/config.yaml` contains standalone Release preview recipes for iOS simulators and Android, with Proof of Changes enabled in the local configuration. The first successful remote builds and a published configuration are required before PR automation is active.

```sh
revyl build --profile preview --platform ios --remote --json
revyl build --profile preview --platform android --remote --json
revyl config validate
revyl config push
revyl github status --json
```

## Hackathon log

The project skill is `.agents/skills/convex-hackathon-skill/SKILL.md`, with its reference kept in `references/log-format.md`. Invoke it after meaningful changes to update `hackathon.md` from repository evidence.
