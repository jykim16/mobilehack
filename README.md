# mobilehack

Expo SDK 58 starter with Expo Router and TypeScript. Routes live in `src/app/`.

## Run

```sh
npm ci
npm start
```

Use `npm run ios`, `npm run android`, or `npm run web` for a specific platform.

## Convex backend

The Cart backend is deployed and live. Use these URLs from the app, the demo scripts and Muse:

- `EXPO_PUBLIC_CONVEX_URL=https://hearty-skunk-641.convex.cloud` (client API, queries/mutations/actions)
- `EXPO_PUBLIC_CONVEX_SITE_URL=https://hearty-skunk-641.convex.site` (HTTP actions: auth routes, MCP endpoint)

The full API contract is in the project drive at `handoffs/api-contract.md`. In short: shoppers sign in with Convex Auth (anonymous), `api.cart.*` handles the cart and evidence, `api.purchases.*` handles quotes and approval, and `api.demo.*` are the demo controls.

Deploy with `npx convex deploy` (needs `CONVEX_DEPLOY_KEY` in the environment).

### Demo and invariant scripts

```sh
node scripts/demo-backend.mjs     # add -> enrichment sections -> price drop -> request -> approve -> order -> shipment
node scripts/invariants.mjs       # purchase invariants: defer=0 orders, double approve=1 order, stale quote rejected, ownership
```

Both default to the deployed URL; pass a URL argument or set `EXPO_PUBLIC_CONVEX_URL` to target another deployment. For local work, run `npx convex dev` in another terminal. Never commit credentials or real env files.

Convex agent guidance lives in `convex/_generated/ai/guidelines.md`. Refresh it and the bundled skills with `npx convex ai-files install`.

## Checks

```sh
npm run typecheck
npm run lint
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
