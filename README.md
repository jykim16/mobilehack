# mobilehack

Expo SDK 58 starter with Expo Router and TypeScript. Routes live in `src/app/`.

## Run

```sh
npm ci
npm start
```

Use `npm run ios`, `npm run android`, or `npm run web` for a specific platform.

## Convex

The Convex dependency and empty schema (`convex/schema.ts`) are ready. No backend deployment, authentication, queries, or mutations have been created.

Run `npm run convex` to sign in and select or create a Convex project. When adding backend-powered screens, configure `EXPO_PUBLIC_CONVEX_URL` in `.env.local` and wrap the app in ConvexProvider. Never commit credentials or real env files.

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
