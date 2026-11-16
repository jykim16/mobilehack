# Hosted payment UI (gated follow-up)

The components in `src/payments` use local presentation models. `whop-adapter.ts` normalizes the published `payments.subaccount` and `payments.status` response fields without calling either endpoint. `paymentCapability.available` is false; no production screen mounts them. The coordinator exposes only reads and opening an existing checkout. It cannot approve a request, create a payment, retry a charge, place an order, or withdraw funds.

## Needed before live wiring

- An unambiguous, authenticated Cart/Muse shopper mapping to the intended existing Whop account. Current mapping is ambiguous; the provider account may be shared. The view model always leaves ownership unconfirmed and never exposes provider account identifiers.
- A reviewed live reader and approval adapter using the published request/quote-bound `approveAndPay`/`startPayment` semantics, not the existing one-tap checkout. Any creation/recovery behavior still needs fixture tests for concurrent calls, restarts and quote replacement before activation.
- Machine-readable cancellation and abandonment distinctions, if the UI is to distinguish them: the current contract maps them to `failed` with a safe reason. The normalizer never guesses from prose.
- Explicit approval to activate after mapping is resolved. No environment flag can enable the live payment capability in this patch.

## Sandbox and balance honesty

The adapter requires explicit sandbox mode and simulated card/retailer capabilities before labeling the simulated leg. Only a backend-marked synthetic card with matching four-digit mask/last4 is shown; null or invalid details are omitted. Customer payment stays separate from "Simulated card / Sandbox retailer charge" and from "Simulated retailer order placed" / "Simulated shipment" events. This path does not import or invoke Amazon code.

Available and pending amounts come only from `providerBalance`, never from the Cart ledger or calculated net proceeds. Negative amounts remain negative; missing amounts, currency or freshness remain unknown. The balance is labeled as a provider account balance, not the shopper's exclusive funds. The core contract now supplies mode/capabilities, provider balance and separate event times, but it does not resolve the current mapping ambiguity. The status response has no update timestamp, so the normalizer does not invent one.

The current legacy `src/data/shop-store.tsx` automatically approves a refreshed stale quote. This follow-up does not touch that release path and must not reuse it. The new coordinator rejects changed versions or material terms and requires a fresh explicit review.

`PaymentReader` is only the eventual normalized read boundary. Production activation must include a separately reviewed live adapter and actual screen wiring, with server-side idempotency proof; a frontend tap lock alone is not a financial idempotency guarantee.

## Fixture-only review

Run `EXPO_NO_DOTENV=1 EXPO_PUBLIC_PAYMENT_FIXTURES=true EXPO_PUBLIC_CONVEX_URL= npx expo start --web`, then open `/payment-preview`. The route redirects away unless both development mode and the explicit fixture flag are present. Every payment, balance and timestamp is labeled sample data. Negative/unknown balance variants use invented fixtures, not live account amounts. The browser is mocked and no provider is contacted.

`npx vitest run --config vitest.payments.config.ts` covers spoofed returns, browser cancellation, stale approval, repeated taps, read-only restart recovery, payment states, pending balances, and masked-card validation. Also run `npx tsc --noEmit`, `npx tsc --noEmit -p convex/tsconfig.json`, and `npx expo lint`.

After live wiring, mount `usePayment` with a stable capability object and the request id recovered from the backend's request list or route. It re-reads on mount, app foregrounding, and browser completion. It never persists a checkout URL or infers a charge outcome from a link/browser result. A webhook-pending payment remains awaiting payment. Query failures show an unconfirmed outcome, not a safe-to-retry charge.
