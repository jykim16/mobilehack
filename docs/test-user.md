# Test-user sign-in

The optional **Sign in as test user** shortcut is for a disposable demo-only account. Keep it free of real purchases, payment data, and privileged access. The normal email/password flow is unchanged.

Configure these values externally in the Expo **development** and **preview** environments, or in an ignored `.env.local` for local development:

| Variable | Value |
| --- | --- |
| `EXPO_PUBLIC_TEST_USER_ENABLED` | `true` (exactly) |
| `EXPO_PUBLIC_TEST_USER_EMAIL` | The disposable account's email |
| `EXPO_PUBLIC_TEST_USER_PASSWORD` | Its password, at least 8 characters |

There are no built-in credentials. Missing/empty values, a short password, or a missing flag hide the shortcut. **Every `EXPO_PUBLIC_*` value is public plaintext in the client bundle, including this email and password. These are not secrets**, even if the build service masks them. Never reuse a personal password or configure these values in the production Expo environment. Do not put actual values in tracked files, screenshots, logs, or reports.

## Environment gate

`app.config.ts` records `extra.appEnvironment` from `EAS_BUILD_PROFILE`, then `APP_ENV`, then the build mode. Native EAS development/preview builds are recognized automatically. Set `APP_ENV=preview` in the external Expo preview environment for preview OTA exports, including Expo Go exports. For a release-mode web preview export, use `APP_ENV=web-preview`. Local Metro/Expo Go development also permits the shortcut when explicitly enabled.

Production builds/exports default to a production environment and hide the shortcut, even if the flag is accidentally enabled. The native `production` update channel also vetoes it. Unknown release environments fail closed. Keep `APP_ENV=production` (or unset) for production publishing; do not label a public production web export as a preview.

## Authentication and cart

The shortcut tries Convex Auth Password `signIn` first. Only `InvalidAccountId` triggers `signUp`; a wrong password, network failure, or any other error never creates an account. Seeding is requested only after a successful demo sign-in, not during normal login or failed authentication.

The live shop provider checks for Sony WH-1000XM6 at `https://www.amazon.com/dp/B0F3PQHWTZ`, including equivalent Amazon product URLs, before adding it. A provider in-flight guard prevents repeated effects, and a stable per-shopper idempotency key lets the existing backend deduplicate concurrent clients/mounts. The seed is one-time: deliberately removing a seeded item does not resurrect it on the next login. No backend or Amazon integration code changes are required. No checkout or order is submitted by this feature.

## Verification

Run `node --test src/data/__tests__/test-user.test.mjs`, `npx tsc --noEmit`, and `npx expo lint`. The focused tests use non-authenticating fixtures; no real account is needed. To exercise a real sign-in, supply the disposable configuration externally, then use the shortcut in a development/preview client. Do not test purchases or connect real payment data.

Ported from [weebao/mobilehack#1](https://github.com/weebao/mobilehack/pull/1), commit `186de9daeeb6c167d76f6db87e8a8c61be69270c`; the source's literal shared credentials were intentionally excluded.
