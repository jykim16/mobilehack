# Amazon release safety

Live submission is disabled in this release by `AMAZON_LIVE_SUBMISSION_ENABLED = false`, and background automation is off by default (see below). Both provider placement APIs stop before submitting; one-tap checkout stops before purchase approval. Do not change the constant to enable purchases: a transactional, authenticated shopper/canonical-order claim and separately verified live-release design are still required.

## Authorization

`checkoutAmazonItem` defaults to a dry run. Both `dryRun: false` and `userConfirmed: true` must be explicit; neither implies the other. `dryRun: true` always wins. The prior implementation derived confirmation from omitted `dryRun` and did **not** enforce the previously documented human-confirmation guarantee. Even explicit confirmation cannot override the release lock.

A dry run still navigates Amazon and isolates the real active basket. The daemon can mutate the cart and attach quotes; neither is a read-only mode. Automated regression tests use only mock DOMs, storage, and dependencies, never real accounts. Disable/mock the daemon in any external test that must avoid cart writes.

## Submission uncertainty

Before dispatch, the submission boundary persists an unknown intent keyed without lossy normalization by opaque shopper ID and canonical order reference, then records an in-memory unknown entry. Persistence errors, failed read-back, missing shopper identity, or an existing intent forbid dispatch. A lost acknowledgement or ambiguous response returns unknown. No timeout, restart, sign-out, or reconciliation deletes the durable intent. Verified confirmation can update application state, but the intent remains a permanent no-resubmit tombstone.

Separate claim instances serialize within one JavaScript runtime and consult storage on every attempt, so a new instance/restart cannot resubmit the same persisted shopper/order pair. SecureStore has no atomic compare-and-set across processes/devices; reinstall, data loss, a different canonical reference, or a second runtime can defeat a local-only guarantee. It is not an exactly-once purchase mechanism. This limitation is why production live submission remains disabled. The engine's injected submission authority is an internal seam exercised by mocks, not a public release-enable switch.

## Reconciliation

Unknown-to-placed inference requires a complete pre-submit order baseline captured no more than 30 seconds before dispatch, exact item/quantity and total alignment, and explicitly timestamp-precision order evidence between dispatch and ten minutes afterward. Known historical IDs and multiple matching candidates are refused. Existing Your Orders scraping supplies calendar dates, not trustworthy timestamp precision; the production provider supplies no complete fresh baseline. Its ambiguous orders therefore stay unknown, even if the same item appears on the same day. The mock-only positive cases supply both pieces of evidence explicitly.

Manual reconciliation means inspecting the real Amazon account and matching a verified Amazon order ID to the canonical order through an authorized support/backend workflow. Never infer placement from the absence of an order, clear an intent to retry, or fabricate an ID. The current local `recordPlaced` transition remains available for verified evidence; this PR adds no user-facing reconciliation UI or backend mutation.

## Background automation (default off)

`enableBackendDaemon` on `<AmazonBrowserProvider>` and `enabled` on `<AmazonSyncDaemon>` default to `false`. With the default, the provider mounts no daemon (no Convex subscriptions, cart poller, Muse/agent cart sync, live quote attachment, or order polling), registers no 60s heartbeat or AppState foreground listener (so resume never calls `syncOrders()` or `refreshCart()`), and never auto-flushes the Convex retry queue. Completing sign-in only updates local session state and settles waiting callers. Pass `true` only after background cart and backend writes are approved for a release. The API is unchanged so it can be re-enabled later.

Remaining mount effects with the default: the WebView loads the Amazon cart page (a GET), the injected bootstrap only reports page/auth state, and owner verification may run a verified Amazon sign-out (a session reset, not a cart or backend write) and clear local Cart state when no trusted owner binding exists. Every cart or order action still requires an explicit caller (`addToCart`, `setQuantity`, `refreshCart`, `syncOrders`, checkout). Without a `convexSync` prop and with the daemon off, nothing reaches Convex.

## Logout proof and reset fences

Sign-out verification needs positive evidence: an Amazon header sign-in prompt with no challenge on an amazon.com page. CAPTCHA, MFA, sign-in, empty, and unrecognized pages report `signedOut: false` and keep the session and owner locked, so the next shopper is never bound on them. Page JavaScript cannot remove HttpOnly cookies, so only the server-side sign-out navigation plus this proof unlocks the browser.

Every active-basket isolation step (navigate, scrape, move saved item, add, quantity step, save for later) checks the session epoch before dispatch and again after the awaited result, so a reset or revocation stops the loop before the next cart mutation. A retry-queue flush that was waiting before `clear()` is dropped instead of flushing the next shopper's jobs through the previous client; those jobs stay queued for their own client. Close, owner revocation, unmount, and a failed reconnect settle every outstanding sign-in waiter as not signed in, so checkout callers cannot hang.

## Restored sessions

The provider fences commands, cached cart/purchase reads, connected status, sign-in completion, browser-sheet exposure, and the daemon until strict SecureStore ownership checks finish. Only an opaque app shopper identifier is persisted; cookies and credentials stay in WebView's native cookie store. A missing/different binding is invalidated before verified server-side sign-out, then bound only after successful reset. Null-to-shopper hydration is checked independently of cookie-detection timing. Offline reset/storage errors keep the browser locked; Connect Amazon retries reset/reconnect.

Owner read/reset/bind transactions serialize across provider instances in one runtime, including pending native writes: a superseded binding write must settle before the next owner can reset and bind. Owner revocation invalidates asynchronous session epochs. Deactivated scopes cannot reconnect, and retained purchase/cache/defer callbacks check their captured owner before touching shared state. A second provider in the same runtime revokes the first provider's authority and exposure; only one provider should be mounted. Native cookie-store behavior across independent runtimes or other apps is not proven here, and app shopper ownership does not attest to which Amazon account a person chooses during sign-in. No real-account, native restart, purchase, or device-isolation verification was performed for this change.
