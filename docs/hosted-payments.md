# Hosted payment UI (gated follow-up)

The components in `src/payments` are local presentation models, **not a deployed Convex contract**. `paymentCapability.available` is false; no production screen mounts them. The coordinator exposes only reads and opening an existing checkout. It cannot approve a request, create a payment, retry a charge, place an order, or withdraw funds.

## Needed before live wiring

- Exact authenticated capability query, payment/balance function names, arguments, validators and response shapes.
- An approval operation bound to `requestId` and `quoteVersion` that does **not** immediately order from the retailer. The currently published `decidePurchase` creates an order, so it is not compatible.
- Idempotent payment creation/recovery semantics (including simultaneous callers, timeouts, restarts and quote replacements) and a lookup/subscription by `requestId`.
- Authoritative status vocabulary and transition semantics; safe failure reasons; payment, order and shipment timestamps; refund and abandoned-state semantics.
- Hosted checkout origin allowlist, expiry/reopen policy, and returned `{ paymentId, checkoutUrl, amountCents, currency }` associated with the approved quote.
- Available/pending balance currency and freshness; KYC requirements; optional backend-masked card data and explicit unsupported issuing status.

The current legacy `src/data/shop-store.tsx` automatically approves a refreshed stale quote. This follow-up does not touch that release path and must not reuse it. The new coordinator rejects changed versions or material terms and requires a fresh explicit review.

`PaymentReader` is only the eventual normalized read boundary. No provisional endpoint names are imported. Production activation must include a separately reviewed adapter and actual screen wiring, with server-side idempotency proof; a frontend tap lock alone is not a financial idempotency guarantee.

## Fixture-only review

Run `EXPO_PUBLIC_PAYMENT_FIXTURES=true EXPO_PUBLIC_CONVEX_URL= npx expo start --web`, then open `/payment-preview`. The route redirects away unless both development mode and the explicit fixture flag are present. Every payment, balance and timestamp is labeled sample data. The browser is mocked and no provider is contacted.

`npx vitest run --config vitest.payments.config.ts` covers spoofed returns, browser cancellation, stale approval, repeated taps, read-only restart recovery, payment states, pending balances, and masked-card validation. Also run `npx tsc --noEmit`, `npx tsc --noEmit -p convex/tsconfig.json`, and `npx expo lint`.

After live wiring, mount `usePayment` with a stable capability object and the request id recovered from the backend's request list or route. It re-reads on mount, app foregrounding, and browser completion. It never persists a checkout URL or infers a charge outcome from a link/browser result. A webhook-pending payment remains awaiting payment. Query failures show an unconfirmed outcome, not a safe-to-retry charge.
