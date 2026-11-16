import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';
import { AMAZON_LIVE_SUBMISSION_ENABLED, DurableSubmissionClaims, PersistedBrowserOwner } from '../durable-safety.ts';

import {
  buildShipmentEvents,
  normalizeShipmentStatus,
  parsePriceToCents,
  sanitizeCarrierHubLocation,
} from '../asin.ts';
import {
  buildAttachClientQuoteArgs,
  buildRecordClientPlacementArgs,
  buildSyncClientShipmentArgs,
} from '../convex-sync.ts';
import {
  evaluatePreSubmitSafetyGate,
  OrderSubmissionLedger,
  resolveOrderConfirmationOutcome,
  shouldStartFreshSignInNavigation,
  verifyActiveBasketBinding,
  verifyCheckoutReviewBinding,
} from '../safety.ts';
import {
  buildAodAddToCartScript,
  buildClearWebViewSessionScript,
  buildInspectCheckoutReviewScript,
  buildMoveSavedToCartScript,
  buildMutateCartRowScript,
  buildSaveCartRowForLaterScript,
  buildScrapeCartScript,
  buildScrapeOrderConfirmationScript,
  buildScrapeProgressTrackerScript,
  buildScrapeYourOrdersScript,
  buildSubmitCheckoutOrderScript,
} from '../scripts.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'expo-secure-store') {
      return {
        shortCircuit: true,
        url:
          'data:text/javascript,' +
          encodeURIComponent(
            'export async function getItemAsync(){throw new Error("SecureStore unavailable in Node test");}' +
              'export async function setItemAsync(){throw new Error("SecureStore unavailable in Node test");}' +
              'export async function deleteItemAsync(){throw new Error("SecureStore unavailable in Node test");}',
          ),
      };
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[a-z0-9]+$/i.test(specifier) &&
      context.parentURL?.includes('/src/amazon/')
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const {
  applyLedgerReconciliationsToState,
  computeLiveCartQuantityPlan,
  ConvexSyncRetryQueue,
  executeIdempotentAddItem,
  resetAmazonSessionStores,
  selectVerifiedAddedCartItem,
  SessionResetBarrier,
  settleSubmittedOrderConfirmation,
  shouldResetAmazonSessionOnShopperChange,
  verifyFinalCartRowQuantity,
} = await import('../reconcile-sync.ts');

const {
  ANDROID_CHROME_USER_AGENT,
  coordinateConvexOneTapApproval,
  executeCartSyncPlan,
  executeDeterministicItemCheckout,
  hasActiveUndeliveredAmazonOrders,
  HEARTBEAT_INTERVAL_MS,
  IPHONE_SAFARI_USER_AGENT,
  isolateSingleActiveCartItem,
  ORDER_SYNC_INTERVAL_MS,
  planConvexCartSyncActions,
  planPendingApprovalQuotes,
  SerializedAsyncRunner,
  selectBrowserEngine,
  selectBrowserUserAgent,
  shouldPollOrderDeliverySync,
  shouldRunIdleHeartbeat,
  SyncedCartLedger,
} = await import('../daemon-engine.ts');

/**
 * Execute an injected WebView step script inside an isolated Node `vm` context
 * with a deterministic mock DOM and capture `ReactNativeWebView.postMessage` + button clicks.
 */
async function runInjectedStepScript(scriptSource, mockEnv = {}) {
  const messages = [];
  let placeOrderClicks = 0;

  const placeOrderBtn = {
    scrollIntoView: () => {},
    click: () => {
      placeOrderClicks += 1;
    },
  };

  const defaultSummaryRows = (mockEnv.summaryLines ?? ['Items (1): $229.99', 'Shipping & handling: FREE', 'Estimated tax: $19.01', 'Order total: $249.00']).map(
    (text) => ({ textContent: text }),
  );

  const defaultLineItems = (
    mockEnv.checkoutItems ?? [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }]
  ).map((it) => ({
    textContent: `${it.title} Qty: ${it.quantity}`,
    contains: () => false,
    getAttribute: (name) => (name === 'data-asin' ? it.asin : null),
    querySelector: (sel) => {
      if (sel.includes('item-title') || sel.includes('asin-title')) {
        return { textContent: it.title };
      }
      if (sel.includes('quantity')) {
        return { textContent: String(it.quantity), value: String(it.quantity) };
      }
      return null;
    },
  }));

  const documentMock = mockEnv.document ?? {
    title: mockEnv.title ?? 'Place your order - Amazon.com Checkout',
    body: { textContent: mockEnv.bodyText ?? '' },
    querySelector: (selector) => {
      if (mockEnv.querySelector) {
        const custom = mockEnv.querySelector(selector, placeOrderBtn);
        if (custom !== undefined) return custom;
      }
      if (selector.includes('validateCaptcha') || selector.includes('otpCode') || selector.includes('ap_email')) {
        return null;
      }
      if (selector.includes('#spc-orders') && selector.includes('order-summary')) {
        return { textContent: 'Checkout' };
      }
      if (selector.includes('.grand-total-price')) {
        return mockEnv.grandTotalText === null
          ? null
          : { textContent: mockEnv.grandTotalText ?? '$249.00' };
      }
      if (selector.includes('placeYourOrder')) {
        return mockEnv.hasPlaceOrderButton === false ? null : placeOrderBtn;
      }
      if (selector.includes('#spc-orders, #checkout-item-block')) {
        return {
          querySelectorAll: () => defaultLineItems,
        };
      }
      return null;
    },
    querySelectorAll: (selector) => {
      if (mockEnv.querySelectorAll) {
        const custom = mockEnv.querySelectorAll(selector);
        if (custom !== undefined) return custom;
      }
      if (selector.includes('#subtotals-marketplace-table tr')) {
        return defaultSummaryRows;
      }
      return [];
    },
  };

  const sandbox = {
    window: {
      ReactNativeWebView: {
        postMessage: (raw) => {
          messages.push(JSON.parse(raw));
        },
      },
    },
    location: {
      href: mockEnv.href ?? 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
      pathname: mockEnv.pathname ?? '/gp/buy/spc/handlers/display.html',
    },
    document: documentMock,
    setTimeout: (fn) => {
      fn();
      return 1;
    },
    clearTimeout: () => {},
    Promise,
    JSON,
    Math,
    Date,
    RegExp,
    Array,
    Object,
    String,
    Number,
    Boolean,
    parseFloat,
    parseInt,
    isFinite,
  };

  vm.runInNewContext(scriptSource, sandbox);
  await new Promise((resolve) => setTimeout(resolve, 15));

  const stepMsg = messages.find((m) => m.type === 'STEP_RESULT');
  assert.ok(stepMsg, 'Expected STEP_RESULT postMessage from injected script');
  assert.equal(stepMsg.ok, true, `Expected step script ok=true, got error: ${stepMsg.error}`);
  return { data: stepMsg.data, placeOrderClicks };
}

// ============================================================================
// (a) dryRun & userConfirmed hard safety gates
// ============================================================================

test('(a) dryRun: true blocks Place Order in BOTH host gate and in-DOM script even when userConfirmed: true and totals match', async () => {
  const hostDecision = evaluatePreSubmitSafetyGate({
    dryRun: true,
    userConfirmed: true,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    requiresSignIn: false,
    basketBound: true,
    checkoutReviewBound: true,
    liveTotalVerified: true,
    liveTotalCents: 24900,
  });
  assert.equal(hostDecision.allowSubmit, false);
  assert.equal(hostDecision.status, 'dry_run_halted');

  const domRun = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-dry', {
      dryRun: true,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
  );
  assert.equal(domRun.placeOrderClicks, 0);
  assert.equal(domRun.data.submitted, false);
  assert.equal(domRun.data.haltedBySafetyGate, true);
  assert.equal(domRun.data.code, 'dry_run_halted');
});

test('(a.2) userConfirmed: false blocks Place Order even when dryRun: false', async () => {
  const hostDecision = evaluatePreSubmitSafetyGate({
    dryRun: false,
    userConfirmed: false,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    requiresSignIn: false,
    basketBound: true,
    checkoutReviewBound: true,
    liveTotalVerified: true,
    liveTotalCents: 24900,
  });
  assert.equal(hostDecision.allowSubmit, false);
  assert.equal(hostDecision.status, 'dry_run_halted');

  const domRun = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-unconfirmed', {
      dryRun: false,
      userConfirmed: false,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
  );
  assert.equal(domRun.placeOrderClicks, 0);
  assert.equal(domRun.data.submitted, false);
});

// ============================================================================
// (b) Fail-closed quote total validation (missing / null / NaN / <=0 / drifted)
// ============================================================================

test('(b.1) missing, null, NaN, non-integer, or <= 0 expectedTotalCents fails closed with zero clicks', async () => {
  for (const badExpected of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -500, 24900.5]) {
    const hostDecision = evaluatePreSubmitSafetyGate({
      dryRun: false,
      userConfirmed: true,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      expectedTotalCents: badExpected,
      requiresSignIn: false,
      basketBound: true,
      checkoutReviewBound: true,
      liveTotalVerified: true,
      liveTotalCents: 24900,
    });
    assert.equal(hostDecision.allowSubmit, false, `Host must reject expectedTotalCents=${String(badExpected)}`);
    assert.equal(hostDecision.status, 'safety_blocked');

    const domRun = await runInjectedStepScript(
      buildSubmitCheckoutOrderScript('req-bad-exp', {
        dryRun: false,
        userConfirmed: true,
        expectedTotalCents: badExpected,
        approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      }),
    );
    assert.equal(domRun.placeOrderClicks, 0, `DOM must not click for expectedTotalCents=${String(badExpected)}`);
    assert.equal(domRun.data.submitted, false);
    assert.equal(domRun.data.code, 'safety_blocked');
  }
});

test('(b.2) missing/unparseable or <= 0 liveTotalCents on checkout DOM fails closed with zero clicks', async () => {
  for (const badLive of [undefined, null, Number.NaN, 0, -100]) {
    const hostDecision = evaluatePreSubmitSafetyGate({
      dryRun: false,
      userConfirmed: true,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      expectedTotalCents: 24900,
      requiresSignIn: false,
      basketBound: true,
      checkoutReviewBound: true,
      liveTotalVerified: badLive === 24900,
      liveTotalCents: badLive,
    });
    assert.equal(hostDecision.allowSubmit, false);
    assert.equal(hostDecision.status, 'safety_blocked');
  }

  // DOM where .grand-total-price and Order total row are absent/empty -> liveTotalCents === null
  const inspectMissingTotal = await runInjectedStepScript(
    buildInspectCheckoutReviewScript('req-inspect-missing'),
    {
      grandTotalText: null,
      summaryLines: ['Items (1): $229.99', 'Shipping & handling: FREE'],
    },
  );
  assert.equal(inspectMissingTotal.data.stage, 'checkout_review');
  assert.equal(inspectMissingTotal.data.totalCents, null);
  assert.equal(inspectMissingTotal.data.canPlaceOrder, false);

  const domMissingTotal = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-no-live-total', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: null,
      summaryLines: ['Items (1): $229.99', 'Shipping & handling: FREE'],
    },
  );
  assert.equal(domMissingTotal.placeOrderClicks, 0);
  assert.equal(domMissingTotal.data.submitted, false);
  assert.equal(domMissingTotal.data.code, 'safety_blocked');
});

test('(b.3) live checkout total differing by > 1 cent fails closed with requote_required and zero clicks', async () => {
  const hostDecision = evaluatePreSubmitSafetyGate({
    dryRun: false,
    userConfirmed: true,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    requiresSignIn: false,
    basketBound: true,
    checkoutReviewBound: true,
    liveTotalVerified: true,
    liveTotalCents: 24902,
  });
  assert.equal(hostDecision.allowSubmit, false);
  assert.equal(hostDecision.status, 'requote_required');

  const domDrifted = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-drift', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: '$303.13',
      summaryLines: ['Items (1): $279.99', 'Estimated tax: $23.14', 'Order total: $303.13'],
    },
  );
  assert.equal(domDrifted.placeOrderClicks, 0);
  assert.equal(domDrifted.data.submitted, false);
  assert.equal(domDrifted.data.code, 'requote_required');
});

// ============================================================================
// (c) Exact basket / ASIN / quantity binding (cart + SPC checkout review)
// ============================================================================

const makeCartRow = (asin, quantity, unitPriceCents = 22999, inStock = true) => ({
  asin,
  cartItemId: `item-${asin}`,
  title: `Product ${asin}`,
  unitPriceCents,
  listPriceCents: null,
  quantity,
  imageUrl: null,
  seller: 'Amazon.com',
  deliveryEstimate: 'Tomorrow',
  returnSummary: '30-day returns',
  inStock,
});

test('(c.1) extra unapproved ASIN or wrong quantity in active /gp/cart/view.html blocks whole-cart checkout', () => {
  // Extra unapproved item in cart (Bose + Sony when only Sony was approved)
  const twoItemsCheck = verifyActiveBasketBinding(
    [makeCartRow('B09XS7JWHH', 1), makeCartRow('B0CCZ26B5V', 1, 32900)],
    { asin: 'B09XS7JWHH', quantity: 1, navCartCount: 2 },
  );
  assert.equal(twoItemsCheck.ok, false);
  assert.equal(twoItemsCheck.code, 'unexpected_cart_items');

  // Quantity mismatch (cart has qty 2, approval was qty 1)
  const qtyMismatch = verifyActiveBasketBinding([makeCartRow('B09XS7JWHH', 2)], {
    asin: 'B09XS7JWHH',
    quantity: 1,
    navCartCount: 2,
  });
  assert.equal(qtyMismatch.ok, false);
  assert.equal(qtyMismatch.code, 'quantity_mismatch');

  // Header cart badge count mismatch (hidden unparsed active item)
  const badgeMismatch = verifyActiveBasketBinding([makeCartRow('B09XS7JWHH', 1)], {
    asin: 'B09XS7JWHH',
    quantity: 1,
    navCartCount: 3,
  });
  assert.equal(badgeMismatch.ok, false);
  assert.equal(badgeMismatch.code, 'unexpected_cart_items');

  // Exact match succeeds
  const exactMatch = verifyActiveBasketBinding([makeCartRow('B09XS7JWHH', 1)], {
    asin: 'B09XS7JWHH',
    quantity: 1,
    navCartCount: 1,
  });
  assert.equal(exactMatch.ok, true);
});

test('(c.2) buildScrapeCartScript ignores Saved-for-Later items while capturing all active cart rows', async () => {
  const activeRow = {
    closest: () => null,
    getAttribute: (attr) =>
      ({ 'data-asin': 'B09XS7JWHH', 'data-price': '229.99', 'data-quantity': '1', 'data-outofstock': '0' })[attr] ??
      null,
    querySelector: (sel) => {
      if (sel.includes('a-truncate-full')) return { textContent: 'Sony WH-1000XM5' };
      if (sel.includes('sc-product-image')) return { getAttribute: () => 'https://m.media-amazon.com/sony.jpg' };
      return null;
    },
  };
  const savedForLaterRow = {
    closest: (sel) => (sel.includes('#sc-saved-cart') ? {} : null),
    getAttribute: (attr) =>
      ({ 'data-asin': 'B0CCZ26B5V', 'data-price': '329.00', 'data-quantity': '1', 'data-outofstock': '0' })[attr] ??
      null,
    querySelector: () => null,
  };

  const { data } = await runInjectedStepScript(buildScrapeCartScript('req-cart'), {
    pathname: '/gp/cart/view.html',
    href: 'https://www.amazon.com/gp/cart/view.html',
    querySelector: (sel) => {
      if (sel.includes('#nav-button-cart')) return { textContent: '1' };
      if (sel.includes('#sc-active-cart')) {
        return { querySelectorAll: () => [activeRow, savedForLaterRow] };
      }
      return null;
    },
  });

  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].asin, 'B09XS7JWHH');
  assert.equal(data.cartCount, 1);
});

test('(c.3) SPC checkout review with extra ASIN or mismatched item count blocks Place Order in BOTH host and DOM', async () => {
  const hostMismatch = verifyCheckoutReviewBinding({
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    summaryItemCount: 2,
    lineItems: [
      { asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 },
      { asin: 'B0CCZ26B5V', title: 'Bose QuietComfort', quantity: 1 },
    ],
  });
  assert.equal(hostMismatch.ok, false);

  const domWrongAsin = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-wrong-asin', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: '$249.00',
      summaryLines: ['Items (1): $229.99', 'Estimated tax: $19.01', 'Order total: $249.00'],
      checkoutItems: [{ asin: 'B0CCZ26B5V', title: 'Bose QuietComfort', quantity: 1 }],
    },
  );
  assert.equal(domWrongAsin.placeOrderClicks, 0);
  assert.equal(domWrongAsin.data.submitted, false);
  assert.equal(domWrongAsin.data.code, 'basket_mismatch');

  const domWrongCount = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-wrong-qty', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: '$249.00',
      summaryLines: ['Items (2): $229.99', 'Estimated tax: $19.01', 'Order total: $249.00'],
      checkoutItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 2 }],
    },
  );
  assert.equal(domWrongCount.placeOrderClicks, 0);
  assert.equal(domWrongCount.data.submitted, false);
  assert.equal(domWrongCount.data.code, 'basket_mismatch');
});

// ============================================================================
// (d) Post-submit confirmation: never fabricate 'placed' or AMZ-PENDING-*
// ============================================================================

test('(d) absent confirmation order ID or auth/error page returns status="unknown" and retailerOrderId=null (never AMZ-PENDING-*)', async () => {
  // 1. Thank-you page without a ###-#######-####### order ID
  const domNoId = await runInjectedStepScript(buildScrapeOrderConfirmationScript('req-conf-none'), {
    pathname: '/gp/buy/thankyou/handlers/display.html',
    href: 'https://www.amazon.com/gp/buy/thankyou/handlers/display.html',
    bodyText: 'Processing your request, please check Your Orders shortly.',
    hasPlaceOrderButton: false,
    querySelector: (sel) => {
      if (sel.includes('#nav-logobar-greeting')) return { textContent: 'Hello, Shopper', getAttribute: () => '' };
      return undefined;
    },
  });
  const resNoId = resolveOrderConfirmationOutcome(domNoId.data);
  assert.equal(resNoId.status, 'unknown');
  assert.equal(resNoId.retailerOrderId, null);

  // 2. Still on checkout review with a payment error alert even if order-like digits appear in page text
  const domErrorPage = await runInjectedStepScript(buildScrapeOrderConfirmationScript('req-conf-err'), {
    pathname: '/gp/buy/spc/handlers/display.html',
    href: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    bodyText: 'There was a problem with your payment method. Ref 114-1234567-1234567',
    hasPlaceOrderButton: true,
    querySelector: (sel, btn) => {
      if (sel.includes('placeYourOrder')) return btn;
      if (sel.includes('a-alert-error')) return { textContent: 'Payment declined' };
      return undefined;
    },
  });
  assert.equal(domErrorPage.data.retailerOrderId, null);
  const resErr = resolveOrderConfirmationOutcome(domErrorPage.data);
  assert.equal(resErr.status, 'unknown');
  assert.equal(resErr.retailerOrderId, null);

  // 3. Real thank-you confirmation surface with valid Amazon order ID succeeds
  const domConfirmed = await runInjectedStepScript(buildScrapeOrderConfirmationScript('req-conf-ok'), {
    pathname: '/gp/buy/thankyou/handlers/display.html',
    href: 'https://www.amazon.com/gp/buy/thankyou/handlers/display.html',
    bodyText: 'Order placed, thanks! Confirmation will be sent to your email. Order # 114-3948571-8827364',
    hasPlaceOrderButton: false,
    querySelector: (sel) => {
      if (sel.includes('#nav-logobar-greeting')) return { textContent: 'Hello, Shopper', getAttribute: () => '' };
      if (sel.includes('#widget-purchaseSummary')) return { textContent: 'Order placed, thanks!' };
      return undefined;
    },
  });
  const resOk = resolveOrderConfirmationOutcome(domConfirmed.data);
  assert.equal(resOk.status, 'placed');
  assert.equal(resOk.retailerOrderId, '114-3948571-8827364');
});

// ============================================================================
// (e) Reconcile-before-retry idempotency ledger + Convex sync & shipment events
// ============================================================================

test('(e) repeat approval/placeOrder on same orderRef cannot double-submit while "unknown" or "placed", and reconciles via syncOrders()', () => {
  const ledger = new OrderSubmissionLedger();
  const orderRef = 'CART-REQ_ABC123';

  // First submit clicked Place Order, but confirmation timed out -> recorded as 'unknown'
  ledger.recordUnknown({
    orderRef,
    submittedAt: 1_700_000_000_000,
    baselineCapturedAt: 1_700_000_000_000,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    preExistingOrderIds: ['114-0000001-0000001'],
  });
  assert.equal(ledger.get(orderRef)?.state, 'unknown');

  // Fabricated AMZ-PENDING-* IDs are rejected even if someone tries to recordPlaced directly
  assert.throws(() => {
    ledger.recordPlaced(orderRef, 'AMZ-PENDING-12345', 1_700_000_001_000);
  });

  // Subsequent syncOrders() observes the real order on Your Orders -> reconciles 'unknown' to 'placed'
  const reconciled = ledger.reconcileFromSyncedOrders([
    {
      retailerOrderId: '114-9988776-5544332',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      totalCents: 24900,
      placedAtPrecision: 'timestamp',
      placedAtMs: 1_700_000_010_000,
      syncedAt: 1_700_000_030_000,
    },
  ]);
  assert.equal(reconciled.length, 1);
  assert.equal(ledger.get(orderRef)?.state, 'placed');
  assert.equal(ledger.get(orderRef)?.retailerOrderId, '114-9988776-5544332');
});

test('(f) positive control + shipment.events chronological ordering & Convex sync payload builders', async () => {
  // Positive control: exact match on all 6 guards clicks Place Order exactly once
  const domOk = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-ok', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: '$249.00',
      summaryLines: ['Items (1): $229.99', 'Shipping & handling: FREE', 'Estimated tax: $19.01', 'Order total: $249.00'],
      checkoutItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }],
    },
  );
  assert.equal(domOk.placeOrderClicks, 1);
  assert.equal(domOk.data.submitted, true);

  // Verify /progress-tracker/package/... scan extraction & oldest-first ordering + PII stripping
  const trackerRun = await runInjectedStepScript(buildScrapeProgressTrackerScript('req-track'), {
    querySelector: (sel) => {
      if (sel.includes('#primaryStatus')) return { textContent: 'Out for delivery' };
      if (sel.includes('trackingId')) return { textContent: 'Shipped with UPS Tracking ID: 1Z999AA10123456784' };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('tracking-event-date-header')) {
        return [
          { className: 'tracking-event-date-header', getAttribute: () => '', textContent: 'Sunday, November 15' },
          {
            className: 'tracking-event-row',
            getAttribute: () => '',
            textContent: '',
            querySelector: (s) => {
              if (s.includes('event-time')) return { textContent: '8:30 AM' };
              if (s.includes('event-message')) return { textContent: 'Out for delivery' };
              if (s.includes('event-location')) return { textContent: '123 Main St Apt 4B' }; // residential street -> must strip to null!
              return null;
            },
          },
          { className: 'tracking-event-date-header', getAttribute: () => '', textContent: 'Saturday, November 14' },
          {
            className: 'tracking-event-row',
            getAttribute: () => '',
            textContent: '',
            querySelector: (s) => {
              if (s.includes('event-time')) return { textContent: '6:15 PM' };
              if (s.includes('event-message')) return { textContent: 'Package arrived at a carrier facility' };
              if (s.includes('event-location')) return { textContent: 'Oakland, CA US' };
              return null;
            },
          },
        ];
      }
      return [];
    },
  });

  const events = buildShipmentEvents({
    rawEvents: trackerRun.data.events,
    status: normalizeShipmentStatus(trackerRun.data.primaryStatus),
    headline: trackerRun.data.primaryStatus,
    placedAt: new Date(2026, 10, 14, 10, 0).getTime(),
    updatedAt: new Date(2026, 10, 15, 9, 0).getTime(),
  });

  assert.equal(events.length, 2);
  assert.ok(events[0].occurredAt < events[1].occurredAt, 'Events must be ordered oldest first');
  assert.equal(events[0].status, 'shipped');
  assert.equal(events[0].location, 'Oakland, CA US');
  assert.equal(events[1].status, 'out_for_delivery');
  assert.equal(events[1].location, null, 'Street address must be stripped to null');
  assert.equal(sanitizeCarrierHubLocation('742 Evergreen Terrace'), null);

  // Verify Convex mutation builders produce exact contract shapes
  const quotePayload = buildAttachClientQuoteArgs({
    requestId: 'req_1',
    quoteVersion: 1,
    quote: {
      retailer: 'amazon',
      retailerName: 'Amazon',
      seller: 'Amazon.com',
      productTitle: 'Sony WH-1000XM5',
      variantLabel: null,
      imageUrl: null,
      quantity: 1,
      unitPriceCents: 22999,
      subtotalCents: 22999,
      taxCents: 1901,
      shippingCents: 0,
      totalCents: 24900,
      currency: 'USD',
      deliveryEstimate: 'Tomorrow',
      returnSummary: '30-day returns',
      quotedAt: 1_700_000_000_000,
      simulated: true,
    },
  });
  assert.equal(quotePayload.quote.simulated, false);
  assert.equal(quotePayload.quote.variantLabel, null);
  assert.equal(quotePayload.quote.imageUrl, null);

  const shipmentObj = {
    status: 'out_for_delivery',
    carrier: 'UPS',
    trackingNumber: '1Z999AA10123456784',
    trackingUrl: 'https://www.amazon.com/progress-tracker/package/1',
    eta: '2026-11-15',
    events,
    updatedAt: 1_700_000_050_000,
    simulated: false,
  };
  const placeArgs = buildRecordClientPlacementArgs({
    orderRef: 'CART-1',
    retailerOrderId: '114-1111111-1111111',
    placedAt: 1_700_000_000_000,
    shipment: shipmentObj,
  });
  const syncArgs = buildSyncClientShipmentArgs({
    orderRef: 'CART-1',
    retailerOrderId: '114-1111111-1111111',
    shipment: shipmentObj,
  });
  assert.equal(placeArgs.shipment?.events.length, 2);
  assert.equal(syncArgs.shipment.simulated, false);
});

test('(g) currency parser ignores embedded item counts ("Items (2): $199.00") & seller digits, and multi-quantity delete refuses stepper decrement', async () => {
  assert.equal(parsePriceToCents('Items (2): $199.00'), 19900);
  assert.equal(parsePriceToCents('Add to Cart from seller onlineshopping22 and price $199.48'), 19948);
  assert.equal(parsePriceToCents('329'), 32900);
  assert.equal(parsePriceToCents('199.48'), 19948);
  assert.equal(parsePriceToCents('Items (2): --'), null);
  assert.equal(parsePriceToCents('Shipping & handling: FREE'), null);

  // Verify in-DOM inspectCheckoutSummaryAndItems parses 'Items (2): $199.00' as subtotalCents=19900 and summaryItemCount=2
  const inspectTwoItems = await runInjectedStepScript(
    buildInspectCheckoutReviewScript('req-two-items'),
    {
      grandTotalText: '$215.42',
      summaryLines: [
        'Items (2): $199.00',
        'Shipping & handling: FREE',
        'Estimated tax: $16.42',
        'Order total: $215.42',
      ],
      checkoutItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 2 }],
    },
  );
  assert.equal(inspectTwoItems.data.summaryItemCount, 2);
  assert.equal(inspectTwoItems.data.subtotalCents, 19900);
  assert.equal(inspectTwoItems.data.taxCents, 1642);
  assert.equal(inspectTwoItems.data.totalCents, 21542);

  // Verify multi-quantity delete NEVER clicks stepper-decrement when delete-active is missing
  let decrementClicked = 0;
  let deleteActiveClicked = 0;
  const multiQtyNoDeleteBtn = await runInjectedStepScript(
    buildMutateCartRowScript('req-del-multi-missing', 'B09XS7JWHH', 'delete'),
    {
      querySelector: (sel) => {
        if (sel.includes('data-asin="B09XS7JWHH"')) {
          return {
            getAttribute: (name) => (name === 'data-quantity' ? '3' : null),
            querySelector: (inner) => {
              if (inner.includes('a-stepper-decrement')) {
                return {
                  scrollIntoView: () => {},
                  click: () => {
                    decrementClicked += 1;
                  },
                };
              }
              return null;
            },
          };
        }
        return null;
      },
    },
  );
  assert.equal(multiQtyNoDeleteBtn.data.mutated, false);
  assert.equal(decrementClicked, 0, 'Must never click stepper-decrement to delete a quantity > 1 item');

  // When explicit delete-active exists on quantity=3 row, clicks delete-active cleanly
  const multiQtyWithDeleteBtn = await runInjectedStepScript(
    buildMutateCartRowScript('req-del-multi-ok', 'B09XS7JWHH', 'delete'),
    {
      querySelector: (sel) => {
        if (sel.includes('data-asin="B09XS7JWHH"')) {
          return {
            getAttribute: (name) => (name === 'data-quantity' ? '3' : null),
            querySelector: (inner) => {
              if (inner.includes('delete-active')) {
                return {
                  scrollIntoView: () => {},
                  click: () => {
                    deleteActiveClicked += 1;
                  },
                };
              }
              return null;
            },
          };
        }
        return null;
      },
    },
  );
  assert.equal(multiQtyWithDeleteBtn.data.mutated, true);
  assert.equal(deleteActiveClicked, 1);
});

// ============================================================================
// (h) PR #10 Review Hardening Regression Suite (Findings 1 through 10)
// ============================================================================

test('(h.1) [HIGH] checkout submission rejects missing, partial, or unidentified ASINs even when count & total match', async () => {
  // Case 1: summaryItemCount=1 and total=$249.00 match, but lineItems has NO parseable ASIN (asin: null)
  const hostUnidentified = verifyCheckoutReviewBinding({
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    summaryItemCount: 1,
    lineItems: [{ asin: null, title: 'Same-priced mystery item', quantity: 1 }],
  });
  assert.equal(hostUnidentified.ok, false);

  const domUnidentified = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-unidentified-asin', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 24900,
      approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    }),
    {
      grandTotalText: '$249.00',
      summaryLines: ['Items (1): $229.99', 'Estimated tax: $19.01', 'Order total: $249.00'],
      checkoutItems: [{ asin: '', title: 'Same-priced mystery item', quantity: 1 }],
    },
  );
  assert.equal(domUnidentified.placeOrderClicks, 0);
  assert.equal(domUnidentified.data.submitted, false);
  assert.equal(domUnidentified.data.code, 'basket_mismatch');

  // Case 2: 2 approved items (Sony + Bose), checkout has Sony + 1 unidentified row (partial ASIN evidence)
  const hostPartial = verifyCheckoutReviewBinding({
    approvedItems: [
      { asin: 'B09XS7JWHH', quantity: 1 },
      { asin: 'B0CCZ26B5V', quantity: 1 },
    ],
    summaryItemCount: 2,
    lineItems: [
      { asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 },
      { asin: null, title: 'Unparsed second item', quantity: 1 },
    ],
  });
  assert.equal(hostPartial.ok, false);

  const domPartial = await runInjectedStepScript(
    buildSubmitCheckoutOrderScript('req-partial-asin', {
      dryRun: false,
      userConfirmed: true,
      expectedTotalCents: 57800,
      approvedItems: [
        { asin: 'B09XS7JWHH', quantity: 1 },
        { asin: 'B0CCZ26B5V', quantity: 1 },
      ],
    }),
    {
      grandTotalText: '$578.00',
      summaryLines: ['Items (2): $534.00', 'Estimated tax: $44.00', 'Order total: $578.00'],
      checkoutItems: [
        { asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 },
        { asin: '', title: 'Unparsed second item', quantity: 1 },
      ],
    },
  );
  assert.equal(domPartial.placeOrderClicks, 0);
  assert.equal(domPartial.data.submitted, false);
  assert.equal(domPartial.data.code, 'basket_mismatch');

  // Case 3: Empty lineItems array even with matching summaryItemCount
  const hostEmptyLines = verifyCheckoutReviewBinding({
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    summaryItemCount: 1,
    lineItems: [],
  });
  assert.equal(hostEmptyLines.ok, false);
});

test('(h.2) historical purchases, unparsed ASINs, mismatched totals/quantities, and ambiguous matches never reconcile unknown orders', async () => {
  const ledger = new OrderSubmissionLedger();
  const submittedAt = new Date('2026-11-15T14:30:00Z').getTime();
  ledger.noteObservedOrderIds(['114-1111111-1111111']);
  ledger.recordUnknown({
    orderRef: 'CART-REQ_HIST',
    submittedAt,
    baselineCapturedAt: submittedAt,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 2 }],
    expectedTotalCents: 49800,
  });

  // None of these invalid candidates may reconcile CART-REQ_HIST:
  const rejected = ledger.reconcileFromSyncedOrders([
    // 1. Pre-existing order ID known before submit
    {
      retailerOrderId: '114-1111111-1111111',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 2. Historical order from an earlier month for the exact same ASIN + qty + total
    {
      retailerOrderId: '114-2222222-2222222',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: new Date('2026-10-01T12:00:00Z').getTime(),
      syncedAt: submittedAt + 5000,
    },
    // 3. Unparsed null ASIN
    {
      retailerOrderId: '114-3333333-3333333',
      asin: null,
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 4. Wrong quantity (qty 1 instead of 2)
    {
      retailerOrderId: '114-4444444-4444444',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 5. Wrong total
    {
      retailerOrderId: '114-5555555-5555555',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 24900,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
  ]);

  assert.equal(rejected.length, 0);
  assert.equal(ledger.get('CART-REQ_HIST')?.state, 'unknown');

  // Ambiguous duplicate same-day orders also remain 'unknown'
  const ambiguous = ledger.reconcileFromSyncedOrders([
    {
      retailerOrderId: '114-6666666-6666666',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 10_000,
    },
    {
      retailerOrderId: '114-7777777-7777777',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
      placedAtPrecision: 'timestamp',
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 10_000,
    },
  ]);
  assert.equal(ambiguous.length, 0);
  assert.equal(ledger.get('CART-REQ_HIST')?.state, 'unknown');

  // Verify buildScrapeYourOrdersScript parses order date + ASINs + quantities from order cards
  const scrapedOrders = await runInjectedStepScript(buildScrapeYourOrdersScript('req-orders'), {
    pathname: '/gp/your-account/order-history',
    href: 'https://www.amazon.com/gp/your-account/order-history',
    querySelector: (sel) => {
      if (sel.includes('#nav-logobar-greeting')) return { textContent: 'Hello, Shopper', getAttribute: () => '' };
      return null;
    },
    querySelectorAll: (sel) => {
      if (sel.includes('.order-card')) {
        return [
          {
            textContent: 'Order placed November 15, 2026 Total $498.00 Order # 114-8888888-9999999 Arriving Tuesday',
            querySelector: (inner) => {
              if (inner.includes('yohtmlc-product-title')) return { textContent: 'Sony WH-1000XM5' };
              if (inner === 'img') return { getAttribute: () => 'https://m.media-amazon.com/sony.jpg' };
              return null;
            },
            querySelectorAll: (inner) => {
              if (inner.includes('/dp/')) {
                return [{ getAttribute: () => '/dp/B09XS7JWHH' }];
              }
              if (inner.includes('item-view-qty')) {
                return [{ textContent: '2' }];
              }
              return [];
            },
          },
        ];
      }
      return [];
    },
  });
  assert.equal(scrapedOrders.data.orders.length, 1);
  assert.equal(scrapedOrders.data.orders[0].retailerOrderId, '114-8888888-9999999');
  assert.deepEqual(scrapedOrders.data.orders[0].items, [{ asin: 'B09XS7JWHH', quantity: 2 }]);
  assert.equal(typeof scrapedOrders.data.orders[0].placedAtMs, 'number');
});

test('(h.3) applyLedgerReconciliationsToState promotes unknown PurchaseRequest to ordered while preserving identities', () => {
  const quote = {
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller: 'Amazon.com',
    productTitle: 'Sony WH-1000XM5',
    variantLabel: 'Black',
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 22999,
    subtotalCents: 22999,
    taxCents: 1901,
    shippingCents: 0,
    totalCents: 24900,
    currency: 'USD',
    deliveryEstimate: 'Arriving Wednesday',
    returnSummary: '30-day returns',
    quotedAt: 1_700_000_000_000,
    simulated: false,
  };

  const activeItem = {
    id: 'item_orig_sony',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    status: 'active',
    quantity: 1,
    reason: 'Travel headphones',
    addedBy: 'app',
    addedAt: 1_700_000_000_000,
    enrichmentStatus: 'ready',
    product: null,
    variant: null,
    offer: null,
    offers: [],
    rating: null,
    price: null,
    priceHistory: null,
  };

  const pendingReq = {
    requestId: 'req_orig_1',
    itemId: 'item_orig_sony',
    offerId: 'offer_1',
    status: 'approved',
    requestedBy: 'app',
    reason: 'Travel headphones',
    quantity: 1,
    quoteVersion: 1,
    quote,
    expiresAt: 1_700_001_800_000,
    decidedAt: 1_700_000_010_000,
    requestedAt: 1_700_000_000_000,
    error: null,
    order: {
      orderId: 'order_orig_1',
      orderRef: 'CART-REQ_ORIG_1',
      status: 'unknown',
      retailerOrderId: null,
      placedAt: null,
      simulated: false,
    },
    shipment: null,
  };

  const applied = applyLedgerReconciliationsToState({
    reconciled: [
      {
        orderRef: 'CART-REQ_ORIG_1',
        retailerOrderId: '114-5556667-7778889',
        placedAt: 1_700_000_060_000,
      },
    ],
    pendingRequests: [pendingReq],
    items: [activeItem],
    purchasedItems: {},
    syncedPurchases: [],
  });

  assert.equal(applied.pendingRequests[0].status, 'ordered');
  assert.equal(applied.pendingRequests[0].requestId, 'req_orig_1');
  assert.equal(applied.pendingRequests[0].order?.orderId, 'order_orig_1');
  assert.equal(applied.pendingRequests[0].order?.status, 'placed');
  assert.equal(applied.pendingRequests[0].order?.retailerOrderId, '114-5556667-7778889');
  assert.equal(applied.items.length, 0);
  assert.equal(applied.purchasedItems.item_orig_sony?.status, 'purchased');
  assert.equal(applied.purchases.length, 1);
  assert.equal(applied.purchases[0].orderId, 'order_orig_1');
  assert.equal(applied.purchases[0].requestId, 'req_orig_1');
  assert.equal(applied.purchases[0].itemId, 'item_orig_sony');
  assert.equal(applied.placementsToSync.length, 1);
  assert.equal(applied.placementsToSync[0].orderRef, 'CART-REQ_ORIG_1');
});

test('(h.4) ConvexSyncRetryQueue retains failed quote/placement/shipment calls, exposes lastSyncError, and flushes cleanly on retry', async () => {
  let shouldFail = true;
  const recordedPlacements = [];
  const snapshots = [];

  const queue = new ConvexSyncRetryQueue((snap) => snapshots.push(snap));
  const client = {
    recordClientPlacement: async (args) => {
      if (shouldFail) {
        throw new Error('Convex network timeout');
      }
      recordedPlacements.push(args);
    },
  };

  const firstAttempt = await queue.enqueuePlacement(
    {
      orderRef: 'CART-RETRY_1',
      retailerOrderId: '114-1234567-7654321',
      placedAt: 1_700_000_000_000,
    },
    client,
  );

  assert.equal(firstAttempt.synced, 0);
  assert.equal(firstAttempt.remaining, 1);
  assert.equal(firstAttempt.lastSyncError, 'Convex network timeout');
  assert.equal(queue.pendingCount, 1);
  assert.equal(recordedPlacements.length, 0);

  // Subsequent replay / syncOrders flush succeeds and clears lastSyncError
  shouldFail = false;
  const secondAttempt = await queue.flush(client);
  assert.equal(secondAttempt.synced, 1);
  assert.equal(secondAttempt.remaining, 0);
  assert.equal(secondAttempt.lastSyncError, null);
  assert.equal(recordedPlacements.length, 1);
  assert.equal(recordedPlacements[0].orderRef, 'CART-RETRY_1');
});

test('(h.5) settleSubmittedOrderConfirmation catches post-submit evalStep timeouts into structured status="unknown" with orderSubmitted=true', async () => {
  const ledger = new OrderSubmissionLedger();
  const syncQueue = new ConvexSyncRetryQueue();
  const quote = {
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller: 'Amazon.com',
    productTitle: 'Sony WH-1000XM5',
    variantLabel: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 22999,
    subtotalCents: 22999,
    taxCents: 1901,
    shippingCents: 0,
    totalCents: 24900,
    currency: 'USD',
    deliveryEstimate: 'Tomorrow',
    returnSummary: '30-day returns',
    quotedAt: 1_700_000_000_000,
    simulated: false,
  };

  const result = await settleSubmittedOrderConfirmation({
    orderRef: 'CART-TIMEOUT_1',
    submittedAt: 1_700_000_000_000,
    baselineCapturedAt: 1_700_000_000_000,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    preExistingOrderIds: ['114-0000000-0000000'],
    verifiedQuote: quote,
    ledger,
    syncQueue,
    readConfirmation: async () => {
      throw new Error('WebView step timed out after 12000ms');
    },
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.safetyGate.orderSubmitted, true);
  assert.equal(result.retailerOrderId, null);
  assert.equal(ledger.get('CART-TIMEOUT_1')?.state, 'unknown');
});

test('(h.5 & h.6) executeIdempotentAddItem never caches failed/CAPTCHA additions so subsequent retry with same key succeeds', async () => {
  const idempotencyMap = new Map();
  let calls = 0;

  // First call hits CAPTCHA -> ok: false -> must throw and NOT cache key
  await assert.rejects(
    () =>
      executeIdempotentAddItem({
        idempotencyMap,
        idempotencyKey: 'idem-add-sony',
        runAddToCart: async () => {
          calls += 1;
          return {
            ok: false,
            asin: 'B09XS7JWHH',
            usedAodFallback: false,
            cartCount: 0,
            subtotalCents: 0,
            addedItem: null,
            cartRows: [],
            syncedAt: Date.now(),
            error: 'Amazon requested CAPTCHA verification.',
          };
        },
      }),
    /CAPTCHA/,
  );
  assert.equal(idempotencyMap.has('idem-add-sony'), false);

  // Retry with exact same idempotencyKey after CAPTCHA clears -> executes and caches real itemId
  const okRes = await executeIdempotentAddItem({
    idempotencyMap,
    idempotencyKey: 'idem-add-sony',
    runAddToCart: async () => {
      calls += 1;
      return {
        ok: true,
        asin: 'B09XS7JWHH',
        usedAodFallback: true,
        cartCount: 1,
        subtotalCents: 22999,
        addedItem: { id: 'amz-item-B09XS7JWHH', url: 'https://www.amazon.com/dp/B09XS7JWHH', quantity: 1 },
        cartRows: [],
        syncedAt: Date.now(),
      };
    },
  });
  assert.equal(calls, 2);
  assert.equal(okRes.itemId, 'amz-item-B09XS7JWHH');
  assert.equal(okRes.deduplicated, false);

  // Third call with same key deduplicates without invoking runAddToCart again
  const dedupRes = await executeIdempotentAddItem({
    idempotencyMap,
    idempotencyKey: 'idem-add-sony',
    runAddToCart: async () => {
      calls += 1;
      throw new Error('Should not run');
    },
  });
  assert.equal(calls, 2);
  assert.equal(dedupRes.deduplicated, true);
});

test('(h.7 & h.8) selectVerifiedAddedCartItem never falls back to unrelated items[0] and buildAodAddToCartScript applies quantity > 1', async () => {
  const existingBose = {
    id: 'amz-item-B0CCZ26B5V',
    url: 'https://www.amazon.com/dp/B0CCZ26B5V',
    quantity: 1,
  };

  // Requested Sony B09XS7JWHH failed to add while Bose was already in cart -> must return null, NEVER Bose!
  assert.equal(selectVerifiedAddedCartItem([existingBose], 'B09XS7JWHH', 1), null);

  // Requested qty=3, cart only has qty=1 -> must return null
  const sonyQty1 = {
    id: 'amz-item-B09XS7JWHH',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    quantity: 1,
  };
  assert.equal(selectVerifiedAddedCartItem([existingBose, sonyQty1], 'B09XS7JWHH', 3), null);

  // Requested qty=3 and cart has qty=3 -> returns Sony item
  const sonyQty3 = { ...sonyQty1, quantity: 3 };
  assert.equal(selectVerifiedAddedCartItem([existingBose, sonyQty3], 'B09XS7JWHH', 3)?.id, 'amz-item-B09XS7JWHH');

  // Verify buildAodAddToCartScript sets offer form quantity when available and reports appliedQuantity=false otherwise
  let selectedQtyValue = '1';
  const aodWithQtyField = await runInjectedStepScript(buildAodAddToCartScript('req-aod-qty', 3), {
    querySelector: (sel) => {
      if (sel.includes('submit.addToCart')) {
        return {
          getAttribute: () => 'Add to Cart from seller ElectronicsHub and price $229.99',
          scrollIntoView: () => {},
          click: () => {},
          closest: () => ({
            querySelector: (qSel) =>
              qSel.includes('quantity')
                ? {
                    get value() {
                      return selectedQtyValue;
                    },
                    set value(v) {
                      selectedQtyValue = v;
                    },
                    dispatchEvent: () => {},
                  }
                : null,
          }),
        };
      }
      return null;
    },
  });
  assert.equal(aodWithQtyField.data.clicked, true);
  assert.equal(aodWithQtyField.data.appliedQuantity, true);
  assert.equal(selectedQtyValue, '3');

  const aodSingleUnitOnly = await runInjectedStepScript(buildAodAddToCartScript('req-aod-noqty', 3), {
    querySelector: (sel) => {
      if (sel.includes('submit.addToCart')) {
        return {
          getAttribute: () => 'Add to Cart from seller ElectronicsHub and price $229.99',
          scrollIntoView: () => {},
          click: () => {},
          closest: () => ({ querySelector: () => null }),
        };
      }
      return null;
    },
  });
  assert.equal(aodSingleUnitOnly.data.clicked, true);
  assert.equal(aodSingleUnitOnly.data.appliedQuantity, false);
});

test('(h.9) computeLiveCartQuantityPlan computes delta from live cart state (preventing queued 1->2->3 overshoot to 4)', () => {
  // Task 1 sees live cart row at qty=1 and increments by 1 -> qty=2
  const plan1 = computeLiveCartQuantityPlan([makeCartRow('B09XS7JWHH', 1)], 'B09XS7JWHH', 2);
  assert.equal(plan1.operation, 'increment');
  assert.equal(plan1.steps, 1);

  // Task 2 runs AFTER Task 1 updated live cart to qty=2 -> reads live qty=2 and increments by 1 (to 3, NOT +2 to 4!)
  const plan2 = computeLiveCartQuantityPlan([makeCartRow('B09XS7JWHH', 2)], 'B09XS7JWHH', 3);
  assert.equal(plan2.operation, 'increment');
  assert.equal(plan2.steps, 1);

  // Final verification rejects mismatched settled quantity and accepts exact match
  assert.equal(verifyFinalCartRowQuantity([makeCartRow('B09XS7JWHH', 4)], 'B09XS7JWHH', 3).ok, false);
  assert.equal(verifyFinalCartRowQuantity([makeCartRow('B09XS7JWHH', 3)], 'B09XS7JWHH', 3).ok, true);
});

test('(h.10) shouldStartFreshSignInNavigation preserves active /ap/mfa, /ap/cvf, /ap/signin, and CAPTCHA challenges on reopen', () => {
  assert.equal(
    shouldStartFreshSignInNavigation({
      isSignedIn: false,
      currentUrl: 'https://www.amazon.com/ap/mfa?ie=UTF8',
      challenge: 'mfa',
    }),
    false,
  );
  assert.equal(
    shouldStartFreshSignInNavigation({
      isSignedIn: false,
      currentUrl: 'https://www.amazon.com/ap/cvf/transactionapproval',
      challenge: 'mfa',
    }),
    false,
  );
  assert.equal(
    shouldStartFreshSignInNavigation({
      isSignedIn: false,
      currentUrl: 'https://www.amazon.com/errors/validateCaptcha',
      challenge: 'captcha',
    }),
    false,
  );
  assert.equal(
    shouldStartFreshSignInNavigation({
      isSignedIn: false,
      currentUrl: 'https://www.amazon.com/ap/signin',
      challenge: 'signin',
    }),
    false,
  );
  // Only starts fresh sign-in navigation when signed out on an ordinary non-challenge page
  assert.equal(
    shouldStartFreshSignInNavigation({
      isSignedIn: false,
      currentUrl: 'https://www.amazon.com/gp/cart/view.html',
      challenge: 'none',
    }),
    true,
  );
});

// ============================================================================
// (i) Shopper Account Scoping & resetSession() / signOut() Isolation (JON-31)
// ============================================================================

test('(i.1) shouldResetAmazonSessionOnShopperChange triggers on sign-out and account switch without cold-boot churn', () => {
  // Same shopper ID -> no reset
  assert.equal(
    shouldResetAmazonSessionOnShopperChange({
      prevShopperId: 'user_A',
      nextShopperId: 'user_A',
      hasRetainedSessionData: true,
    }),
    false,
  );

  // Clean cold-boot auth hydration (null -> user_A) with no prior Amazon data -> no reset
  assert.equal(
    shouldResetAmazonSessionOnShopperChange({
      prevShopperId: null,
      nextShopperId: 'user_A',
      hasRetainedSessionData: false,
    }),
    false,
  );

  // Sign-out (user_A -> null) -> MUST reset
  assert.equal(
    shouldResetAmazonSessionOnShopperChange({
      prevShopperId: 'user_A',
      nextShopperId: null,
      hasRetainedSessionData: false,
    }),
    true,
  );

  // Direct account switch (user_A -> user_B) -> MUST reset
  assert.equal(
    shouldResetAmazonSessionOnShopperChange({
      prevShopperId: 'user_A',
      nextShopperId: 'user_B',
      hasRetainedSessionData: true,
    }),
    true,
  );

  // Pre-auth anonymous Amazon session followed by sign-in (null -> user_B) -> MUST reset
  assert.equal(
    shouldResetAmazonSessionOnShopperChange({
      prevShopperId: null,
      nextShopperId: 'user_B',
      hasRetainedSessionData: true,
    }),
    true,
  );
});

test('(i.2) resetAmazonSessionStores + buildClearWebViewSessionScript wipe ledger, retry queue, caches, and WebView storage/cookies', async () => {
  const ledger = new OrderSubmissionLedger();
  ledger.recordPlaced('CART-OLD-USER-A', '114-1234567-7654321', 1_700_000_000_000);

  let latestSnap = { pendingCount: 0, lastSyncError: null };
  const syncQueue = new ConvexSyncRetryQueue((snap) => {
    latestSnap = snap;
  });
  await syncQueue.enqueuePlacement(
    {
      orderRef: 'CART-OLD-USER-A',
      retailerOrderId: '114-1234567-7654321',
      placedAt: 1_700_000_000_000,
    },
    {
      recordClientPlacement: async () => {
        throw new Error('Backend error before sign-out');
      },
    },
  );
  assert.equal(syncQueue.pendingCount, 1);
  assert.equal(syncQueue.lastSyncError, 'Backend error before sign-out');

  const idempotencyMap = new Map([['idem-1', 'amz-item-B09XS7JWHH']]);
  const productCache = new Map([['B09XS7JWHH', { title: 'Sony WH-1000XM5' }]]);

  const empty = resetAmazonSessionStores({
    ledger,
    syncQueue,
    idempotencyMap,
    productCache,
  });

  assert.equal(empty.isSignedIn, false);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.purchases, []);
  assert.deepEqual(empty.purchasedItems, {});
  assert.deepEqual(empty.pendingRequests, []);
  assert.equal(empty.lastSyncedAt, null);
  assert.equal(empty.lastSyncError, null);
  assert.equal(ledger.get('CART-OLD-USER-A'), undefined);
  assert.equal(syncQueue.pendingCount, 0);
  assert.equal(syncQueue.lastSyncError, null);
  assert.equal(latestSnap.pendingCount, 0);
  assert.equal(latestSnap.lastSyncError, null);
  assert.equal(idempotencyMap.size, 0);
  assert.equal(productCache.size, 0);

  // Verify buildClearWebViewSessionScript expires accessible cookies and clears Web Storage without returning values
  const expiredWrites = [];
  let localCleared = false;
  let sessionCleared = false;

  const docMock = {
    get cookie() {
      return 'csm-hit=tb:123; skin=noskin';
    },
    set cookie(val) {
      expiredWrites.push(val);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };

  const sandboxMessages = [];
  const context = vm.createContext({
    console,
    Date,
    Math,
    document: docMock,
    location: { pathname: '/', href: 'https://www.amazon.com/' },
    window: {
      localStorage: {
        clear: () => {
          localCleared = true;
        },
      },
      sessionStorage: {
        clear: () => {
          sessionCleared = true;
        },
      },
      ReactNativeWebView: {
        postMessage: (raw) => sandboxMessages.push(JSON.parse(raw)),
      },
    },
  });
  context.window.document = docMock;

  vm.runInContext(buildClearWebViewSessionScript('req-clear-session'), context);
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(sandboxMessages.length, 1);
  assert.equal(sandboxMessages[0].ok, true);
  assert.equal(sandboxMessages[0].data.clearedCookies, 2);
  assert.equal(localCleared, true);
  assert.equal(sessionCleared, true);
  assert.ok(expiredWrites.length >= 2);
  assert.ok(expiredWrites.every((w) => w.includes('Max-Age=0') && !w.includes('tb:123')));
});

test('(i.3) SessionResetBarrier fences mid-flight confirmation and addItem continuations across account switches', async () => {
  const barrier = new SessionResetBarrier();
  const ledger = new OrderSubmissionLedger();
  const syncQueue = new ConvexSyncRetryQueue();
  const idempotencyMap = new Map();
  let placementSynced = 0;

  const startEpoch = barrier.epoch;
  assert.equal(barrier.isCurrent(startEpoch), true);

  const quote = {
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller: 'Amazon.com',
    productTitle: 'Sony WH-1000XM5',
    variantLabel: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 22999,
    subtotalCents: 22999,
    taxCents: 1901,
    shippingCents: 0,
    totalCents: 24900,
    currency: 'USD',
    deliveryEstimate: 'Tomorrow',
    returnSummary: '30-day returns',
    quotedAt: 1_700_000_000_000,
    simulated: false,
  };

  // Account switch happens WHILE readConfirmation() is awaiting!
  const settled = await settleSubmittedOrderConfirmation({
    orderRef: 'CART-STALE-EPOCH',
    submittedAt: 1_700_000_000_000,
    baselineCapturedAt: 1_700_000_000_000,
    approvedItems: [{ asin: 'B09XS7JWHH', quantity: 1 }],
    expectedTotalCents: 24900,
    verifiedQuote: quote,
    ledger,
    syncQueue,
    convexSync: {
      recordClientPlacement: async () => {
        placementSynced += 1;
      },
    },
    isSessionCurrent: () => barrier.isCurrent(startEpoch),
    readConfirmation: async () => {
      barrier.beginReset({ requiresBrowserSignOut: true });
      ledger.clear();
      syncQueue.clear();
      return {
        retailerOrderId: '114-2223334-5556667',
        isConfirmationSurface: true,
        hasAuthOrErrorBarrier: false,
        currentUrl: 'https://www.amazon.com/gp/buy/thankyou/handlers/display.html',
      };
    },
  });

  // Must NOT write Shopper A's order into cleared ledger or enqueue placement under Shopper B!
  assert.equal(settled.status, 'unknown');
  assert.equal(ledger.get('CART-STALE-EPOCH'), undefined);
  assert.equal(placementSynced, 0);
  assert.equal(syncQueue.pendingCount, 0);

  // Likewise executeIdempotentAddItem rejects and leaves idempotencyMap untouched if reset occurred mid-add
  await assert.rejects(
    () =>
      executeIdempotentAddItem({
        idempotencyMap,
        idempotencyKey: 'idem-stale-add',
        isSessionCurrent: () => barrier.isCurrent(startEpoch),
        runAddToCart: async () => ({
          ok: true,
          asin: 'B09XS7JWHH',
          usedAodFallback: false,
          cartCount: 1,
          subtotalCents: 22999,
          addedItem: { id: 'amz-item-B09XS7JWHH', url: 'https://www.amazon.com/dp/B09XS7JWHH', quantity: 1 },
          cartRows: [],
          syncedAt: Date.now(),
        }),
      }),
    /reset/,
  );
  assert.equal(idempotencyMap.size, 0);
});

test('(i.4) SessionResetBarrier keeps Amazon operations fail-closed locked when sign-out fails offline until signedIn=false is verified on amazon.com', () => {
  const barrier = new SessionResetBarrier();
  const resetEpoch = barrier.beginReset({ requiresBrowserSignOut: true });
  assert.equal(barrier.isLogoutPending, true);
  assert.equal(barrier.isCurrent(resetEpoch), false);

  // 1. Offline / blank URL fails verification and keeps session locked
  const offlineVerdict = barrier.verifySignOutResult(resetEpoch, {
    currentUrl: 'about:blank',
    signedIn: false,
  });
  assert.equal(offlineVerdict.ok, false);
  assert.equal(barrier.isLogoutPending, true);
  assert.equal(barrier.isCurrent(resetEpoch), false);

  // 2. Still signed in on amazon.com (HttpOnly cookie survived) fails verification and keeps session locked
  const stillSignedInVerdict = barrier.verifySignOutResult(resetEpoch, {
    currentUrl: 'https://www.amazon.com/gp/cart/view.html',
    signedIn: true,
  });
  assert.equal(stillSignedInVerdict.ok, false);
  assert.equal(barrier.isLogoutPending, true);
  assert.equal(barrier.isCurrent(resetEpoch), false);

  // 3. Verified signedIn=false on https://www.amazon.com/... unlocks the new session epoch
  const okVerdict = barrier.verifySignOutResult(resetEpoch, {
    currentUrl: 'https://www.amazon.com/gp/cart/view.html',
    signedIn: false,
  });
  assert.equal(okVerdict.ok, true);
  assert.equal(barrier.isLogoutPending, false);
  assert.equal(barrier.isCurrent(resetEpoch), true);
});

test('(i.5) ConvexSyncRetryQueue.clear() aborts active multi-job flushes and never deletes newly enqueued jobs sharing a key', async () => {
  const dispatched = [];
  let resolveFirstJob;

  const clientA = {
    recordClientPlacement: (args) =>
      new Promise((resolve) => {
        dispatched.push(`A:${args.orderRef}:${args.retailerOrderId}`);
        resolveFirstJob = resolve;
      }),
    syncClientShipment: async (args) => {
      dispatched.push(`A-ship:${args.retailerOrderId}`);
    },
  };

  const queue = new ConvexSyncRetryQueue();

  // Seed two queued jobs by failing while offline first
  await queue.enqueuePlacement(
    {
      orderRef: 'CART-SHARED-KEY',
      retailerOrderId: '114-1111111-1111111',
      placedAt: 1_700_000_000_000,
    },
    {
      recordClientPlacement: async () => {
        throw new Error('offline');
      },
    },
  );
  await queue.enqueueShipment(
    {
      orderRef: 'CART-SHARED-KEY',
      retailerOrderId: '114-1111111-1111111',
      shipment: { status: 'shipped', events: [], updatedAt: 1_700_000_001_000 },
    },
    {
      syncClientShipment: async () => {
        throw new Error('offline');
      },
    },
  );
  assert.equal(queue.pendingCount, 2);

  // Start flushing under Shopper A; job #1 hangs in-flight
  const inFlightFlush = queue.flush(clientA);
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(dispatched, ['A:CART-SHARED-KEY:114-1111111-1111111']);

  // Account switch clears queue while job #1 is in flight, AND Shopper B enqueues a new job with the same key (kept pending via offline client)
  queue.clear();
  assert.equal(queue.pendingCount, 0);

  await queue.enqueuePlacement(
    {
      orderRef: 'CART-SHARED-KEY',
      retailerOrderId: '114-9999999-9999999',
      placedAt: 1_700_000_050_000,
    },
    {
      recordClientPlacement: async () => {
        throw new Error('shopper B transient retry');
      },
    },
  );
  assert.equal(queue.pendingCount, 1);

  // Now Shopper A's in-flight job #1 settles -> MUST NOT dispatch Shopper A's job #2 AND MUST NOT delete Shopper B's new job!
  resolveFirstJob();
  await inFlightFlush;

  assert.deepEqual(dispatched, ['A:CART-SHARED-KEY:114-1111111-1111111']);
  assert.equal(queue.pendingCount, 1);

  // Flushing under Shopper B dispatches Shopper B's replacement order ID cleanly
  const shopperBSynced = [];
  const resB = await queue.flush({
    recordClientPlacement: async (args) => {
      shopperBSynced.push(args.retailerOrderId);
    },
  });
  assert.equal(resB.synced, 1);
  assert.equal(queue.pendingCount, 0);
  assert.deepEqual(shopperBSynced, ['114-9999999-9999999']);
});

// ============================================================================
// (j) JON-32: Persistent WebKit/Chromium session, Convex Muse poller & One-Tap Checkout
// ============================================================================

test('(j.1) selectBrowserEngine & selectBrowserUserAgent return iOS Safari UA and Android Chrome 131 UA omitting "; wv"', () => {
  assert.equal(selectBrowserEngine('ios'), 'webkit');
  assert.equal(selectBrowserEngine('android'), 'chromium');
  assert.equal(selectBrowserEngine('web'), 'unsupported');

  const iosUa = selectBrowserUserAgent('ios');
  assert.equal(iosUa, IPHONE_SAFARI_USER_AGENT);
  assert.equal(
    iosUa,
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  );

  const androidUa = selectBrowserUserAgent('android');
  assert.equal(androidUa, ANDROID_CHROME_USER_AGENT);
  assert.equal(
    androidUa,
    'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  );
  assert.equal(androidUa.includes('; wv'), false);
  assert.equal(androidUa.includes('wv)'), false);

  assert.equal(selectBrowserUserAgent('web'), undefined);
});

test('(j.2) shouldRunIdleHeartbeat enforces 60s idle keep-alive and pauses during challenges, busy queue, sheet open, or logout', () => {
  const base = {
    appState: 'active',
    busyCount: 0,
    isSheetOpen: false,
    isResetting: false,
    currentUrl: 'https://www.amazon.com/gp/cart/view.html',
    challenge: 'none',
    lastHeartbeatAt: 1_700_000_000_000,
    now: 1_700_000_000_000 + HEARTBEAT_INTERVAL_MS,
  };

  assert.equal(HEARTBEAT_INTERVAL_MS, 60_000);
  assert.equal(shouldRunIdleHeartbeat(base), true);
  assert.equal(shouldRunIdleHeartbeat({ ...base, now: base.lastHeartbeatAt + 59_999 }), false);
  assert.equal(shouldRunIdleHeartbeat({ ...base, appState: 'background' }), false);
  assert.equal(shouldRunIdleHeartbeat({ ...base, busyCount: 1 }), false);
  assert.equal(shouldRunIdleHeartbeat({ ...base, isSheetOpen: true }), false);
  assert.equal(shouldRunIdleHeartbeat({ ...base, isResetting: true }), false);
  assert.equal(shouldRunIdleHeartbeat({ ...base, challenge: 'mfa' }), false);
  assert.equal(
    shouldRunIdleHeartbeat({ ...base, currentUrl: 'https://www.amazon.com/ap/cvf/verify' }),
    false,
  );
  assert.equal(
    shouldRunIdleHeartbeat({
      ...base,
      now: base.lastHeartbeatAt + 20_000,
      forceOnForeground: true,
    }),
    true,
  );
  assert.equal(
    shouldRunIdleHeartbeat({
      ...base,
      now: base.lastHeartbeatAt + 5_000,
      forceOnForeground: true,
    }),
    false,
  );
});

test('(j.3) SyncedCartLedger persists per-shopper records, falls back cleanly when SecureStore throws, and isolates shoppers', async () => {
  // Throwing storage adapter verifies graceful in-memory fallback when SecureStore throws
  const throwingStorage = {
    getItem: async () => {
      throw new Error('SecureStore unavailable');
    },
    setItem: async () => {
      throw new Error('SecureStore quota exceeded');
    },
    removeItem: async () => {
      throw new Error('SecureStore unavailable');
    },
  };
  const fallbackLedger = new SyncedCartLedger(throwingStorage, 'user_fallback');
  await fallbackLedger.hydrate('user_fallback');
  await fallbackLedger.recordSynced('item_fallback_1', {
    asin: 'B09XS7JWHH',
    quantity: 1,
    signedIn: false,
    syncedAt: 1_700_000_000_000,
  });
  assert.equal(fallbackLedger.get('item_fallback_1')?.asin, 'B09XS7JWHH');

  // Durable storage adapter round-trip + shopper isolation
  const memoryDisk = new Map();
  const storage = {
    getItem: async (k) => memoryDisk.get(k) ?? null,
    setItem: async (k, v) => {
      memoryDisk.set(k, v);
    },
    removeItem: async (k) => {
      memoryDisk.delete(k);
    },
  };

  const ledger1 = new SyncedCartLedger(storage, 'shopper_alpha');
  await ledger1.hydrate('shopper_alpha');
  await ledger1.recordSynced('convex_item_1', {
    asin: 'B09XS7JWHH',
    quantity: 2,
    signedIn: true,
    syncedAt: 1_700_000_010_000,
  });

  // Reload in a fresh instance for shopper_alpha -> durable state recovered
  const ledgerReloaded = new SyncedCartLedger(storage, 'shopper_alpha');
  await ledgerReloaded.hydrate('shopper_alpha');
  assert.deepEqual(ledgerReloaded.get('convex_item_1'), {
    asin: 'B09XS7JWHH',
    quantity: 2,
    signedIn: true,
    syncedAt: 1_700_000_010_000,
  });

  // Switch to shopper_beta -> sees empty ledger without touching shopper_alpha's key
  await ledgerReloaded.hydrate('shopper_beta');
  assert.equal(ledgerReloaded.get('convex_item_1'), undefined);

  // Switch back to shopper_alpha and reset() on sign-out / resetSession
  await ledgerReloaded.hydrate('shopper_alpha');
  assert.equal(ledgerReloaded.get('convex_item_1')?.quantity, 2);
  await ledgerReloaded.reset('shopper_alpha');
  assert.equal(ledgerReloaded.get('convex_item_1'), undefined);
});

test('(j.4) Muse MCP poller prioritizes addedBy="agent", deduplicates, syncs qty deltas, and avoids double-adding on sign-in flip', async () => {
  const storageMap = new Map();
  const ledger = new SyncedCartLedger(
    {
      getItem: async (k) => storageMap.get(k) ?? null,
      setItem: async (k, v) => storageMap.set(k, v),
      removeItem: async (k) => storageMap.delete(k),
    },
    'shopper_muse',
  );
  await ledger.hydrate('shopper_muse');

  const convexItems = [
    {
      id: 'item_app_later',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      status: 'active',
      quantity: 1,
      addedBy: 'app',
      addedAt: 1_700_000_005_000,
    },
    {
      id: 'item_non_amazon',
      url: 'https://www.walmart.com/ip/123456',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: 1_700_000_001_000,
    },
    {
      id: 'item_muse_1',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: 1_700_000_002_000,
      variant: { id: 'v1', label: 'Midnight Black' },
    },
    {
      id: 'item_purchased_ignored',
      url: 'https://www.amazon.com/dp/B07FZ8S74R',
      status: 'purchased',
      quantity: 1,
      addedBy: 'agent',
      addedAt: 1_700_000_003_000,
    },
  ];

  // 1. Initial signed-out poll: agent item comes BEFORE app item; non-Amazon & purchased ignored
  const plan1 = planConvexCartSyncActions({
    activeItems: convexItems,
    ledger,
    isSignedIn: false,
    now: 1_700_000_010_000,
  });
  assert.deepEqual(
    plan1.map((a) => ({ kind: a.kind, id: a.item.id, asin: a.asin, addedBy: a.item.addedBy })),
    [
      { kind: 'add_item', id: 'item_muse_1', asin: 'B09XS7JWHH', addedBy: 'agent' },
      { kind: 'add_item', id: 'item_app_later', asin: 'B08N5WRWNW', addedBy: 'app' },
    ],
  );

  const calls = [];
  await executeCartSyncPlan({
    actions: plan1,
    ledger,
    isSignedIn: false,
    now: () => 1_700_000_010_000,
    addToCart: async (input) => {
      calls.push(`add:${input.asin}:${input.quantity}`);
      return { ok: true, syncedAt: 1_700_000_010_000 };
    },
    setQuantity: async (args) => {
      calls.push(`qty:${args.itemId}:${args.quantity}`);
      return null;
    },
    refreshCart: async () => [],
  });
  assert.deepEqual(calls, ['add:B09XS7JWHH:1', 'add:B08N5WRWNW:1']);

  // 2. Next poll while still signed-out with identical items -> ZERO actions (deduplicated)
  const plan2 = planConvexCartSyncActions({
    activeItems: convexItems,
    ledger,
    isSignedIn: false,
    now: 1_700_000_015_000,
  });
  assert.equal(plan2.length, 0);

  // 3. Shopper signs in (`false -> true` transition):
  //    Suppose Amazon merged B09XS7JWHH into the signed-in cart, while B08N5WRWNW was dropped on sign-in!
  const planSignIn = planConvexCartSyncActions({
    activeItems: convexItems,
    ledger,
    isSignedIn: true,
    now: 1_700_000_020_000,
  });
  assert.equal(planSignIn.every((a) => a.kind === 'resync_on_signin'), true);

  calls.length = 0;
  await executeCartSyncPlan({
    actions: planSignIn,
    ledger,
    isSignedIn: true,
    now: () => 1_700_000_020_000,
    addToCart: async (input) => {
      calls.push(`add:${input.asin}:${input.quantity}`);
      return { ok: true, syncedAt: 1_700_000_020_000 };
    },
    setQuantity: async (args) => {
      calls.push(`qty:${args.itemId}:${args.quantity}`);
      return null;
    },
    refreshCart: async () => [
      {
        id: 'amz-item-B09XS7JWHH',
        url: 'https://www.amazon.com/dp/B09XS7JWHH',
        status: 'active',
        quantity: 1,
        reason: null,
        addedBy: 'app',
        addedAt: 1_700_000_020_000,
        enrichmentStatus: 'ready',
        product: null,
        variant: null,
        offer: null,
        offers: [],
        rating: null,
        price: null,
        priceHistory: null,
      },
    ],
  });
  // B09XS7JWHH was ALREADY in the signed-in cart -> NOT double-added! B08N5WRWNW was missing -> re-added once!
  assert.deepEqual(calls, ['add:B08N5WRWNW:1']);
  assert.equal(ledger.get('item_muse_1')?.signedIn, true);
  assert.equal(ledger.get('item_app_later')?.signedIn, true);

  // 4. Muse updates quantity of B09XS7JWHH from 1 -> 3 -> update_quantity action
  const updatedConvexItems = convexItems.map((it) =>
    it.id === 'item_muse_1' ? { ...it, quantity: 3 } : it,
  );
  const planQty = planConvexCartSyncActions({
    activeItems: updatedConvexItems,
    ledger,
    isSignedIn: true,
    now: 1_700_000_030_000,
  });
  assert.equal(planQty.length, 1);
  assert.equal(planQty[0].kind, 'update_quantity');
  assert.equal(planQty[0].targetQuantity, 3);
});

test('(j.5) planPendingApprovalQuotes & shouldPollOrderDeliverySync target only eligible signed-in Amazon approvals and active orders', () => {
  const now = 1_700_000_100_000;
  const activeItems = [
    {
      id: 'item_amz',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: now - 10_000,
    },
    {
      id: 'item_other',
      url: 'https://www.target.com/p/123',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: now - 10_000,
    },
  ];

  const pendingApprovals = [
    {
      requestId: 'req_sim',
      itemId: 'item_amz',
      offerId: 'off_1',
      status: 'pending_approval',
      quantity: 2,
      quoteVersion: 1,
      quote: { simulated: true, totalCents: 25000 },
      expiresAt: now + 600_000,
    },
    {
      requestId: 'req_already_live',
      itemId: 'item_amz',
      offerId: 'off_1',
      status: 'pending_approval',
      quantity: 1,
      quoteVersion: 2,
      quote: { simulated: false, totalCents: 24900 },
      expiresAt: now + 600_000,
    },
    {
      requestId: 'req_non_amz',
      itemId: 'item_other',
      offerId: 'off_2',
      status: 'pending_approval',
      quantity: 1,
      quoteVersion: 1,
      quote: { simulated: true, totalCents: 1999 },
      expiresAt: now + 600_000,
    },
  ];

  // Signed out -> never attempts checkout quote scraping
  assert.equal(
    planPendingApprovalQuotes({
      pendingApprovals,
      activeItems,
      isSignedIn: false,
      now,
      attemptedQuoteMap: new Map(),
    }).length,
    0,
  );

  // Signed in -> quotes only req_sim (simulated quote on Amazon item)
  const candidates = planPendingApprovalQuotes({
    pendingApprovals,
    activeItems,
    isSignedIn: true,
    now,
    attemptedQuoteMap: new Map(),
  });
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].requestId, 'req_sim');
  assert.equal(candidates[0].asin, 'B09XS7JWHH');
  assert.equal(candidates[0].quantity, 2);

  // Order delivery sync gating (30s interval)
  assert.equal(ORDER_SYNC_INTERVAL_MS, 30_000);
  const deliveredOnly = [
    {
      orderId: 'ord_1',
      orderRef: 'CART-1',
      retailerOrderId: '114-1111111-1111111',
      status: 'placed',
      quote: { retailer: 'amazon' },
      shipment: { status: 'delivered' },
    },
  ];
  assert.equal(hasActiveUndeliveredAmazonOrders(deliveredOnly), false);

  const inTransit = [
    {
      orderId: 'ord_2',
      orderRef: 'CART-2',
      retailerOrderId: '114-2222222-2222222',
      status: 'placed',
      quote: { retailer: 'amazon' },
      shipment: { status: 'in_transit' },
    },
  ];
  assert.equal(hasActiveUndeliveredAmazonOrders(inTransit), true);
  assert.equal(
    shouldPollOrderDeliverySync({
      isSignedIn: true,
      hasUndeliveredOrders: true,
      lastOrderSyncAt: now - 30_000,
      now,
    }),
    true,
  );
  assert.equal(
    shouldPollOrderDeliverySync({
      isSignedIn: true,
      hasUndeliveredOrders: true,
      lastOrderSyncAt: now - 10_000,
      now,
    }),
    false,
  );
});

test('(j.6) SerializedAsyncRunner serializes overlapping daemon ticks and coalesces queued wakes', async () => {
  const runner = new SerializedAsyncRunner();
  const log = [];
  let releaseFirst;
  const firstGate = new Promise((r) => {
    releaseFirst = r;
  });
  let passCount = 0;

  const runTick = async () => {
    passCount += 1;
    const current = passCount;
    log.push(`tick${current}:start`);
    if (current === 1) {
      await firstGate;
    }
    log.push(`tick${current}:end`);
  };

  const p1 = runner.trigger(runTick);
  // Trigger 2 overlapping wakes while tick 1 is still running -> coalesced into a single rerun
  const p2 = runner.trigger(runTick);
  const p3 = runner.trigger(runTick);

  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(log, ['tick1:start']);

  releaseFirst();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(log, ['tick1:start', 'tick1:end', 'tick2:start', 'tick2:end']);
});

test('(j.7) buildSaveCartRowForLaterScript & buildMoveSavedToCartScript target #sc-active-cart and #sc-saved-cart cleanly', async () => {
  let savedClickedAsin = null;
  let movedClickedAsin = null;

  const makeRow = (asin, kind) => ({
    asin,
    getAttribute: (attr) => {
      if (attr === 'data-asin') return asin;
      if (attr === 'data-removed' || attr === 'data-saved') return null;
      return null;
    },
    closest: () => null,
    querySelector: (sel) => {
      if (kind === 'active' && sel.includes('save-for-later')) {
        return {
          scrollIntoView: () => {},
          click: () => {
            savedClickedAsin = asin;
          },
        };
      }
      if (kind === 'saved' && sel.includes('move-to-cart')) {
        return {
          scrollIntoView: () => {},
          click: () => {
            movedClickedAsin = asin;
          },
        };
      }
      return null;
    },
    querySelectorAll: () => [],
  });

  const activeRows = [makeRow('B08N5WRWNW', 'active'), makeRow('B09XS7JWHH', 'active')];
  const savedRows = [makeRow('B07FZ8S74R', 'saved')];

  const activeContainer = {
    querySelectorAll: (sel) => {
      const m = sel.match(/data-asin="([^"]+)"/);
      return m ? activeRows.filter((r) => r.asin === m[1]) : activeRows;
    },
  };
  const savedContainer = {
    querySelector: (sel) => {
      const m = sel.match(/data-asin="([^"]+)"/);
      return (m ? savedRows.find((r) => r.asin === m[1]) : savedRows[0]) ?? null;
    },
  };

  const saveRes = await runInjectedStepScript(
    buildSaveCartRowForLaterScript('req-save', 'B08N5WRWNW'),
    {
      pathname: '/gp/cart/view.html',
      href: 'https://www.amazon.com/gp/cart/view.html',
      querySelector: (sel) => (sel.includes('#sc-active-cart') ? activeContainer : null),
    },
  );
  assert.equal(saveRes.data.mutated, true);
  assert.equal(savedClickedAsin, 'B08N5WRWNW');

  const moveRes = await runInjectedStepScript(
    buildMoveSavedToCartScript('req-move', 'B07FZ8S74R'),
    {
      pathname: '/gp/cart/view.html',
      href: 'https://www.amazon.com/gp/cart/view.html',
      querySelector: (sel) => (sel.includes('#sc-saved-cart') ? savedContainer : null),
    },
  );
  assert.equal(moveRes.data.mutated, true);
  assert.equal(movedClickedAsin, 'B07FZ8S74R');
});

test('(j.8) isolateSingleActiveCartItem saves extra ASINs for later, restores target ASIN, and fails closed if extra item remains', async () => {
  // Simulated live Amazon cart with an extra item B08N5WRWNW active and target B09XS7JWHH saved-for-later
  let activeCart = [{ asin: 'B08N5WRWNW', title: 'MacBook Cable', quantity: 1, unitPriceCents: 1999 }];
  const savedForLater = new Set(['B09XS7JWHH']);
  const ops = [];

  const makeSnap = () => ({
    signedIn: true,
    challenge: 'none',
    currentUrl: 'https://www.amazon.com/gp/cart/view.html',
    cartCount: activeCart.reduce((s, r) => s + r.quantity, 0),
    subtotalCents: activeCart.reduce((s, r) => s + (r.unitPriceCents ?? 0) * r.quantity, 0),
    items: activeCart.map((r) => ({
      ...r,
      imageUrl: null,
      inStock: true,
      seller: 'Amazon.com',
    })),
  });

  const isolated = await isolateSingleActiveCartItem({
    asin: 'B09XS7JWHH',
    quantity: 2,
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    navigateToCart: async () => {
      ops.push('nav:cart');
    },
    scrapeCart: async () => makeSnap(),
    moveSavedToCart: async (asin) => {
      ops.push(`move_saved:${asin}`);
      if (savedForLater.has(asin)) {
        savedForLater.delete(asin);
        activeCart.push({ asin, title: 'Sony WH-1000XM5', quantity: 1, unitPriceCents: 22999 });
        return { mutated: true };
      }
      return { mutated: false };
    },
    addTargetToCart: async () => {
      ops.push('add_target');
      return { ok: true };
    },
    stepRowQuantity: async (asin, op) => {
      ops.push(`step:${asin}:${op}`);
      activeCart = activeCart.map((r) =>
        r.asin === asin ? { ...r, quantity: r.quantity + (op === 'increment' ? 1 : -1) } : r,
      );
      return { mutated: true };
    },
    saveRowForLater: async (extraAsin) => {
      ops.push(`save_for_later:${extraAsin}`);
      activeCart = activeCart.filter((r) => r.asin !== extraAsin);
      savedForLater.add(extraAsin);
      return { mutated: true };
    },
    waitMs: async () => {},
  });

  assert.equal(isolated.ok, true);
  assert.deepEqual(isolated.savedForLaterAsins, ['B08N5WRWNW']);
  assert.equal(isolated.matchedRows.length, 1);
  assert.equal(isolated.matchedRows[0].asin, 'B09XS7JWHH');
  assert.equal(isolated.matchedRows[0].quantity, 2);
  assert.ok(ops.includes('move_saved:B09XS7JWHH'));
  assert.ok(ops.includes('step:B09XS7JWHH:increment'));
  assert.ok(ops.includes('save_for_later:B08N5WRWNW'));

  // Negative case: if an extra active item refuses to move to Save-for-Later -> fail closed!
  const stuckRes = await isolateSingleActiveCartItem({
    asin: 'B09XS7JWHH',
    quantity: 2,
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    navigateToCart: async () => {},
    scrapeCart: async () => ({
      signedIn: true,
      challenge: 'none',
      currentUrl: 'https://www.amazon.com/gp/cart/view.html',
      cartCount: 3,
      subtotalCents: 47997,
      items: [
        { asin: 'B09XS7JWHH', title: 'Sony', quantity: 2, unitPriceCents: 22999, imageUrl: null, inStock: true, seller: 'Amazon.com' },
        { asin: 'B000STUCK0', title: 'Stuck Item', quantity: 1, unitPriceCents: 1999, imageUrl: null, inStock: true, seller: 'Amazon.com' },
      ],
    }),
    moveSavedToCart: async () => ({ mutated: false }),
    addTargetToCart: async () => ({ ok: true }),
    stepRowQuantity: async () => ({ mutated: true }),
    saveRowForLater: async () => ({ mutated: false, reason: 'save_for_later_control_not_found' }),
    waitMs: async () => {},
  });
  assert.equal(stuckRes.ok, false);
  assert.equal(stuckRes.status, 'basket_mismatch');
  assert.match(stuckRes.reason, /B000STUCK0/);
});

test('(j.9) checkoutAmazonItem enforces sign-in, dryRun:true halt, and exact Convex attachClientQuote -> decidePurchase -> PlaceOrder -> recordClientPlacement sequence', async () => {
  const sequence = [];
  let signedIn = false;
  let placeOrderClicked = 0;

  const cartItem = {
    id: 'j57convexitem001',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    status: 'active',
    quantity: 1,
    reason: 'ANC headphones',
    addedBy: 'agent',
    addedAt: 1_700_000_000_000,
    enrichmentStatus: 'ready',
    product: {
      id: 'prod_sony',
      title: 'Sony WH-1000XM5 Wireless Headphones',
      brand: 'Sony',
      category: 'Audio',
      imageUrl: 'https://m.media-amazon.com/images/I/sony.jpg',
      description: null,
    },
    variant: { id: 'var_black', label: 'Black' },
    offer: {
      id: 'off_amz_sony',
      retailer: 'amazon',
      retailerName: 'Amazon',
      seller: 'Amazon.com',
      priceCents: 22999,
      listPriceCents: 29999,
      shippingCents: 0,
      inStock: true,
      dealText: null,
      deliveryEstimate: 'Tomorrow',
      returnSummary: '30-day Amazon return window',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
    },
    offers: [],
    rating: null,
    price: null,
    priceHistory: null,
  };

  const makeCommonDeps = () => ({
    isSignedIn: () => signedIn,
    ensureSignedIn: async () => {
      sequence.push('ensureSignedIn');
      signedIn = true;
      return true;
    },
    closeBrowserSheet: () => {
      sequence.push('closeBrowserSheet');
    },
    submissionAuthority: { available: true, claim: async () => true },
    captureOrderBaseline: async () => ({ capturedAt: Date.now(), orderIds: [] }),
    runExclusive: async (fn) => fn(),
    isolationDeps: {
      navigateToCart: async () => {},
      scrapeCart: async () => ({
        signedIn: true,
        challenge: 'none',
        currentUrl: 'https://www.amazon.com/gp/cart/view.html',
        cartCount: 1,
        subtotalCents: 22999,
        items: [
          {
            asin: 'B09XS7JWHH',
            title: 'Sony WH-1000XM5 Wireless Headphones',
            quantity: 1,
            unitPriceCents: 22999,
            imageUrl: 'https://m.media-amazon.com/images/I/sony.jpg',
            inStock: true,
            seller: 'Amazon.com',
          },
        ],
      }),
      moveSavedToCart: async () => ({ mutated: false }),
      addTargetToCart: async () => ({ ok: true }),
      stepRowQuantity: async () => ({ mutated: true }),
      saveRowForLater: async () => ({ mutated: true }),
      waitMs: async () => {},
    },
    syncCartRowsToState: () => [],
    proceedToCheckoutAndInspect: async () => {
      sequence.push('spcInspect');
      return {
        stage: 'checkout_review',
        signedIn: true,
        challenge: 'none',
        canPlaceOrder: true,
        subtotalCents: 22999,
        shippingCents: 0,
        taxCents: 1901,
        totalCents: 24900,
        summaryItemCount: 1,
        lineItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }],
        deliveryEstimate: 'Arriving Wednesday, Nov 18',
        currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
      };
    },
    submitCheckoutOrder: async (guard) => {
      assert.equal(guard.dryRun, false);
      assert.equal(guard.userConfirmed, true);
      assert.equal(guard.expectedTotalCents, 24900);
      assert.deepEqual(guard.approvedItems, [{ asin: 'B09XS7JWHH', quantity: 1 }]);
      placeOrderClicked += 1;
      sequence.push('submitPlaceOrder');
      return { submitted: true, haltedBySafetyGate: false };
    },
    readConfirmation: async () => {
      sequence.push('readConfirmation');
      return {
        retailerOrderId: '114-3334444-5556666',
        deliveryEstimate: 'Arriving Wednesday, Nov 18',
        isConfirmationSurface: true,
        hasAuthOrErrorBarrier: false,
        currentUrl: 'https://www.amazon.com/gp/buy/thankyou/handlers/display.html',
      };
    },
    reconcileViaSyncOrders: async () => ({
      ok: true,
      requiresSignIn: false,
      purchases: [],
      syncedAt: Date.now(),
    }),
    getPreExistingOrderIds: () => [],
    onOrderPlacedLocalState: async ({ orderRef, retailerOrderId }) => {
      sequence.push(`localState:${orderRef}:${retailerOrderId}`);
    },
    submissionLedger: new OrderSubmissionLedger(),
    syncQueue: new ConvexSyncRetryQueue(),
    convexSync: {
      recordClientPlacement: async (args) => {
        sequence.push(`recordClientPlacement:${args.orderRef}:${args.retailerOrderId}`);
      },
      syncClientShipment: async (args) => {
        sequence.push(`syncClientShipment:${args.orderRef}:${args.shipment.status}`);
      },
    },
    convexCoordinator: {
      findPendingApprovalForItem: async () => null,
      requestPurchase: async (args) => {
        sequence.push(`requestPurchase:${args.itemId}`);
        return {
          requestId: 'req_convex_101',
          status: 'pending_approval',
          quoteVersion: 1,
          expiresAt: Date.now() + 900_000,
          quote: { ...cartItem.offer, simulated: true },
        };
      },
      attachClientQuote: async (args) => {
        assert.equal(args.quote.simulated, false);
        assert.equal(args.quote.totalCents, 24900);
        sequence.push(`attachClientQuote:${args.requestId}:v${args.quoteVersion}->v2`);
        return { quoteVersion: 2, quote: args.quote };
      },
      decidePurchase: async (args) => {
        // Must receive quoteVersion=2 returned from attachClientQuote!
        assert.equal(args.quoteVersion, 2);
        assert.equal(args.decision, 'approve');
        sequence.push(`decidePurchase:${args.requestId}:v${args.quoteVersion}`);
        return {
          outcome: 'approved',
          request: {
            requestId: args.requestId,
            itemId: cartItem.id,
            offerId: cartItem.offer.id,
            status: 'approved',
            requestedBy: 'app',
            reason: 'Checkout approved in Cart',
            quantity: 1,
            quoteVersion: 2,
            quote: null,
            expiresAt: Date.now() + 900_000,
            decidedAt: Date.now(),
            requestedAt: Date.now(),
            error: null,
            order: {
              orderId: 'ord_convex_101',
              orderRef: 'CART-AWAITING1',
              status: 'awaiting_client',
              retailerOrderId: null,
              placedAt: Date.now(),
              simulated: false,
            },
            shipment: null,
          },
        };
      },
    },
  });

  // 1. Automated dryRun: true -> verifies isolation + SPC quote, NEVER touches Convex decidePurchase or #placeYourOrder!
  const dryRes = await executeDeterministicItemCheckout({
    ...makeCommonDeps(),
    input: { item: cartItem, dryRun: true, userConfirmed: true },
  });
  assert.equal(dryRes.status, 'dry_run_halted');
  assert.equal(dryRes.safetyGate.orderSubmitted, false);
  assert.equal(dryRes.quote?.totalCents, 24900);
  assert.equal(placeOrderClicked, 0);
  assert.deepEqual(sequence, ['ensureSignedIn', 'closeBrowserSheet', 'spcInspect']);

  for (const flags of [{}, { dryRun: false }, { userConfirmed: true }, { dryRun: false, userConfirmed: false }, { dryRun: true, userConfirmed: true }]) {
    sequence.length = 0;
    const result = await executeDeterministicItemCheckout({ ...makeCommonDeps(), input: { item: cartItem, ...flags } });
    assert.equal(result.status, 'dry_run_halted');
    assert.equal(placeOrderClicked, 0);
    assert.deepEqual(sequence, ['spcInspect']);
  }
  const disabled = await executeDeterministicItemCheckout({
    ...makeCommonDeps(), submissionAuthority: undefined,
    input: { item: cartItem, dryRun: false, userConfirmed: true },
  });
  assert.equal(disabled.status, 'safety_blocked');
  assert.equal(placeOrderClicked, 0);
  assert.equal(AMAZON_LIVE_SUBMISSION_ENABLED, false);

  const records = new Map();
  const storage = { getItem: async (key) => records.get(key) ?? null, setItem: async (key, value) => { records.set(key, value); } };
  const claim = new DurableSubmissionClaims(storage);
  const lostAckDeps = makeCommonDeps();
  let dispatches = 0;
  const attempt = (claims, ledger) => executeDeterministicItemCheckout({
    ...lostAckDeps,
    input: { item: cartItem, dryRun: false, userConfirmed: true },
    submissionLedger: ledger,
    submissionAuthority: { available: true, claim: (ref, at) => claims.claim('opaque-shopper', ref, at) },
    submitCheckoutOrder: async () => {
      dispatches += 1;
      assert.equal(ledger.get('CART-AWAITING1')?.state, 'unknown');
      assert.equal(records.size, 1);
      throw new Error('mock lost WebView acknowledgement');
    },
  });
  const lost = await attempt(claim, new OrderSubmissionLedger());
  assert.equal(lost.status, 'unknown');
  const restarted = await attempt(new DurableSubmissionClaims(storage), new OrderSubmissionLedger());
  assert.equal(restarted.status, 'unknown');
  assert.equal(dispatches, 1);
  const unavailable = await attempt(new DurableSubmissionClaims({ getItem: async () => { throw new Error('unavailable'); }, setItem: async () => {} }), new OrderSubmissionLedger());
  assert.equal(unavailable.status, 'unknown');
  assert.equal(dispatches, 1);

  // 2. Human-confirmed live checkout (`userConfirmed: true`, `dryRun: false`) -> exact Convex + WebKit sequence!
  sequence.length = 0;
  const liveDeps = makeCommonDeps();
  const liveRes = await executeDeterministicItemCheckout({
    ...liveDeps,
    input: { item: cartItem, dryRun: false, userConfirmed: true },
  });

  assert.equal(liveRes.status, 'placed');
  assert.equal(liveRes.orderRef, 'CART-AWAITING1');
  assert.equal(liveRes.retailerOrderId, '114-3334444-5556666');
  assert.equal(liveRes.safetyGate.orderSubmitted, true);
  assert.equal(placeOrderClicked, 1);

  assert.deepEqual(sequence, [
    'spcInspect',
    'requestPurchase:j57convexitem001',
    'attachClientQuote:req_convex_101:v1->v2',
    'decidePurchase:req_convex_101:v2',
    'submitPlaceOrder',
    'readConfirmation',
    'recordClientPlacement:CART-AWAITING1:114-3334444-5556666',
    'syncClientShipment:CART-AWAITING1:ordered',
    'localState:CART-AWAITING1:114-3334444-5556666',
  ]);

  // 3. Re-invoking on the same orderRef returns idempotent replay without clicking #placeYourOrder a second time!
  const dupRes = await executeDeterministicItemCheckout({
    ...liveDeps,
    input: {
      item: cartItem,
      orderRef: 'CART-AWAITING1',
      dryRun: false,
      userConfirmed: true,
    },
  });
  assert.equal(dupRes.status, 'placed');
  assert.equal(dupRes.safetyGate.orderSubmitted, false);
  assert.equal(placeOrderClicked, 1);
});

test('(l.1) durable claims serialize separate instances, retain unknown across restart, and scope shopper/order without lossy keys', async () => {
  const records = new Map();
  const storage = { getItem: async (key) => records.get(key) ?? null, setItem: async (key, value) => { records.set(key, value); } };
  const first = new DurableSubmissionClaims(storage);
  const second = new DurableSubmissionClaims(storage);
  assert.deepEqual(await Promise.all([first.claim('A', 'canonical', 100), second.claim('A', 'canonical', 100)]), [true, false]);
  assert.equal(await new DurableSubmissionClaims(storage).claim('A', 'canonical', 200), false);
  assert.equal(await second.claim('B', 'canonical', 200), true);
  assert.equal(await first.claim('A!', 'canonical', 200), true);
  assert.equal(await first.claim(null, 'canonical', 200), false);
  const rejectingWrite = new DurableSubmissionClaims({ getItem: async () => null, setItem: async () => { throw new Error('disk unavailable'); } });
  assert.equal(await rejectingWrite.claim('A', 'other', 200), false);
});

test('(l.2) cold boot and null-to-B cookie timing cannot expose a session before persisted owner and verified reset', async () => {
  const records = new Map();
  const storage = { getItem: async (key) => records.get(key) ?? null, setItem: async (key, value) => { records.set(key, value); } };
  const owner = new PersistedBrowserOwner(storage);
  let resets = 0;
  let finishReset;
  const initializing = owner.initialize('B', async () => { resets += 1; await new Promise((resolve) => { finishReset = resolve; }); });
  assert.equal(owner.isReady('B'), false);
  while (!finishReset) await Promise.resolve();
  assert.equal(owner.isReady('B'), false);
  finishReset();
  assert.equal(await initializing, true);
  assert.equal(resets, 1);
  assert.equal(owner.isReady('B'), true);
  assert.equal(owner.isReady('A'), false);
  const restored = new PersistedBrowserOwner(storage);
  assert.equal(restored.isReady('B'), false);
  assert.equal(await restored.initialize('B', async () => { throw new Error('must not reset trusted owner'); }), true);
  const switched = new PersistedBrowserOwner(storage);
  assert.equal(await switched.initialize('A', async () => { throw new Error('offline signout'); }), false);
  assert.equal(switched.isReady('A'), false);
  const nullBoot = new PersistedBrowserOwner(storage);
  assert.equal(await nullBoot.initialize(null, async () => { resets += 1; }), false);
  assert.equal(nullBoot.isReady('B'), false);
  assert.equal(await nullBoot.initialize('B', async () => { resets += 1; }), true);
  assert.equal(resets, 3);
  assert.deepEqual([...records.values()], ['B']);
  const unavailable = new PersistedBrowserOwner({ getItem: async () => { throw new Error('storage unavailable'); }, setItem: async () => {} });
  assert.equal(await unavailable.initialize('B', async () => {}), false);
  assert.equal(unavailable.isReady('B'), false);
});

test('(l.3) unknown reconciliation rejects earlier same-day, date-only, stale/missing baseline and out-of-window evidence', () => {
  const submittedAt = Date.parse('2026-11-15T14:30:00Z');
  const candidate = {
    retailerOrderId: '114-1234567-1234567', asin: 'B09XS7JWHH',
    items: [{ asin: 'B09XS7JWHH', quantity: 1 }], totalCents: 24900,
    placedAtMs: submittedAt + 1000, placedAtPrecision: 'timestamp', syncedAt: submittedAt + 5000,
  };
  for (const [baselineCapturedAt, changes] of [
    [submittedAt, { placedAtMs: submittedAt - 5.5 * 60 * 60 * 1000 }],
    [submittedAt, { placedAtPrecision: 'date' }],
    [submittedAt, { placedAtPrecision: undefined }],
    [submittedAt - 30_001, {}], [undefined, {}], [submittedAt + 1, {}],
    [submittedAt, { placedAtMs: submittedAt + 10 * 60 * 1000 + 1 }],
  ]) {
    const ledger = new OrderSubmissionLedger();
    ledger.recordUnknown({ orderRef: 'canonical', submittedAt, baselineCapturedAt, approvedItems: candidate.items, expectedTotalCents: 24900 });
    assert.deepEqual(ledger.reconcileFromSyncedOrders([{ ...candidate, ...changes }]), []);
    assert.equal(ledger.get('canonical')?.state, 'unknown');
  }
  const ledger = new OrderSubmissionLedger();
  ledger.recordUnknown({ orderRef: 'canonical', submittedAt, baselineCapturedAt: submittedAt, approvedItems: candidate.items, expectedTotalCents: 24900 });
  assert.equal(ledger.reconcileFromSyncedOrders([candidate]).length, 1);
  const manual = new OrderSubmissionLedger();
  manual.recordUnknown({ orderRef: 'canonical', submittedAt, approvedItems: candidate.items, expectedTotalCents: 24900 });
  manual.recordPlaced('canonical', candidate.retailerOrderId, submittedAt + 1000);
  assert.equal(manual.get('canonical')?.state, 'placed');
});

test('(j.10) coordinateConvexOneTapApproval reuses existing pending approval and fails closed on stale_quote', async () => {
  const quote = {
    retailer: 'amazon',
    retailerName: 'Amazon',
    seller: 'Amazon.com',
    productTitle: 'Sony WH-1000XM5',
    variantLabel: null,
    imageUrl: null,
    quantity: 1,
    unitPriceCents: 22999,
    subtotalCents: 22999,
    taxCents: 1901,
    shippingCents: 0,
    totalCents: 24900,
    currency: 'USD',
    deliveryEstimate: 'Tomorrow',
    returnSummary: '30-day returns',
    quotedAt: 1_700_000_000_000,
    simulated: false,
  };

  const res = await coordinateConvexOneTapApproval({
    coordinator: {
      findPendingApprovalForItem: async () => ({
        requestId: 'req_stale',
        itemId: 'item_1',
        offerId: 'off_1',
        status: 'pending_approval',
        requestedBy: 'agent',
        reason: 'Test',
        quantity: 1,
        quoteVersion: 1,
        quote,
        expiresAt: 1_700_000_900_000,
        decidedAt: null,
        requestedAt: 1_700_000_000_000,
        error: null,
        order: null,
        shipment: null,
      }),
      requestPurchase: async () => {
        throw new Error('should not call requestPurchase when pending exists');
      },
      attachClientQuote: async () => ({ quoteVersion: 2, quote }),
      decidePurchase: async () => ({
        outcome: 'stale_quote',
        request: {
          requestId: 'req_stale',
          itemId: 'item_1',
          offerId: 'off_1',
          status: 'pending_approval',
          requestedBy: 'agent',
          reason: 'Test',
          quantity: 1,
          quoteVersion: 3,
          quote,
          expiresAt: 1_700_000_900_000,
          decidedAt: null,
          requestedAt: 1_700_000_000_000,
          error: null,
          order: null,
          shipment: null,
        },
      }),
    },
    item: {
      id: 'item_1',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
      status: 'active',
      quantity: 1,
      reason: null,
      addedBy: 'agent',
      addedAt: 1_700_000_000_000,
      enrichmentStatus: 'ready',
      product: null,
      variant: null,
      offer: { id: 'off_1' },
      offers: [],
      rating: null,
      price: null,
      priceHistory: null,
    },
    liveQuote: quote,
  });

  assert.equal(res.ok, false);
  assert.equal(res.status, 'requote_required');
});

test('(j.11) checkoutAmazonItem falls back to status="unknown" on unverified confirmation DOM and immediately reconciles via syncOrders()', async () => {
  const ledger = new OrderSubmissionLedger();
  const syncQueue = new ConvexSyncRetryQueue();
  let syncOrdersInvoked = 0;

  const cartItem = {
    id: 'item_reconcile_fallback',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    status: 'active',
    quantity: 1,
    reason: null,
    addedBy: 'app',
    addedAt: 1_700_000_000_000,
    enrichmentStatus: 'ready',
    product: {
      id: 'prod_1',
      title: 'Sony WH-1000XM5',
      brand: 'Sony',
      category: 'Audio',
      imageUrl: null,
      description: null,
    },
    variant: null,
    offer: null,
    offers: [],
    rating: null,
    price: null,
    priceHistory: null,
  };

  const res = await executeDeterministicItemCheckout({
    input: { item: cartItem, dryRun: false, userConfirmed: true },
    isSignedIn: () => true,
    ensureSignedIn: async () => true,
    closeBrowserSheet: () => {},
    submissionAuthority: { available: true, claim: async () => true },
    captureOrderBaseline: async () => ({ capturedAt: Date.now(), orderIds: [] }),
    runExclusive: async (fn) => fn(),
    isolationDeps: {
      navigateToCart: async () => {},
      scrapeCart: async () => ({
        signedIn: true,
        challenge: 'none',
        currentUrl: 'https://www.amazon.com/gp/cart/view.html',
        cartCount: 1,
        subtotalCents: 22999,
        items: [
          {
            asin: 'B09XS7JWHH',
            title: 'Sony WH-1000XM5',
            quantity: 1,
            unitPriceCents: 22999,
            imageUrl: null,
            inStock: true,
            seller: 'Amazon.com',
          },
        ],
      }),
      moveSavedToCart: async () => ({ mutated: false }),
      addTargetToCart: async () => ({ ok: true }),
      stepRowQuantity: async () => ({ mutated: true }),
      saveRowForLater: async () => ({ mutated: true }),
      waitMs: async () => {},
    },
    syncCartRowsToState: () => {},
    proceedToCheckoutAndInspect: async () => ({
      stage: 'checkout_review',
      signedIn: true,
      challenge: 'none',
      canPlaceOrder: true,
      subtotalCents: 22999,
      shippingCents: 0,
      taxCents: 1901,
      totalCents: 24900,
      summaryItemCount: 1,
      lineItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }],
      deliveryEstimate: 'Arriving Thursday',
      currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    }),
    submitCheckoutOrder: async () => ({ submitted: true, haltedBySafetyGate: false }),
    readConfirmation: async () => ({
      retailerOrderId: null,
      isConfirmationSurface: false,
      hasAuthOrErrorBarrier: false,
      currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    }),
    reconcileViaSyncOrders: async () => {
      syncOrdersInvoked += 1;
      const now = Date.now();
      ledger.reconcileFromSyncedOrders([
        {
          retailerOrderId: '114-7654321-0987654',
          asin: 'B09XS7JWHH',
          items: [{ asin: 'B09XS7JWHH', quantity: 1 }],
          totalCents: 24900,
          placedAtPrecision: 'timestamp',
      placedAtMs: now,
          syncedAt: now,
        },
      ]);
      return {
        ok: true,
        requiresSignIn: false,
        purchases: [
          {
            orderId: 'amz-ord-114-7654321-0987654',
            orderRef: 'CART-0987654',
            requestId: 'amz-req-1',
            itemId: cartItem.id,
            status: 'placed',
            retailerOrderId: '114-7654321-0987654',
            placedAt: now,
            quote: null,
            simulated: false,
            shipment: {
              status: 'ordered',
              carrier: null,
              trackingNumber: null,
              trackingUrl: null,
              eta: null,
              events: [],
              updatedAt: now,
              simulated: false,
            },
          },
        ],
        syncedAt: now,
      };
    },
    getPreExistingOrderIds: () => [],
    onOrderPlacedLocalState: async () => {},
    submissionLedger: ledger,
    syncQueue,
    convexSync: null,
    convexCoordinator: null,
  });

  assert.equal(syncOrdersInvoked, 1);
  assert.equal(res.status, 'placed');
  assert.equal(res.retailerOrderId, '114-7654321-0987654');
  assert.equal(res.safetyGate.orderSubmitted, true);
});

// ============================================================================
// (k) Review regression tests for PR #29 findings
// ============================================================================

test('(k.1) [HIGH] retrying checkoutAmazonItem({ item }) without orderRef reuses itemId->orderRef binding, reconciles via syncOrders(), and never double-orders', async () => {
  const ledger = new OrderSubmissionLedger();
  const syncQueue = new ConvexSyncRetryQueue();
  let requestPurchaseCount = 0;
  let placeOrderClicked = 0;
  let orderVisibleInYourOrders = false;
  const placementCalls = [];

  const cartItem = {
    id: 'convex_item_retry_guard',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    status: 'active',
    quantity: 1,
    reason: 'Retry test',
    addedBy: 'agent',
    addedAt: 1_700_000_000_000,
    enrichmentStatus: 'ready',
    product: {
      id: 'prod_sony',
      title: 'Sony WH-1000XM5',
      brand: 'Sony',
      category: 'Audio',
      imageUrl: null,
      description: null,
    },
    variant: null,
    offer: {
      id: 'off_sony_1',
      retailer: 'amazon',
      retailerName: 'Amazon',
      seller: 'Amazon.com',
      priceCents: 22999,
      listPriceCents: null,
      shippingCents: 0,
      inStock: true,
      dealText: null,
      deliveryEstimate: 'Tomorrow',
      returnSummary: '30-day returns',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
    },
    offers: [],
    rating: null,
    price: null,
    priceHistory: null,
  };

  const makeAttemptDeps = () => ({
    input: { item: cartItem, dryRun: false, userConfirmed: true }, // NOTE: NO orderRef or requestId passed!
    isSignedIn: () => true,
    ensureSignedIn: async () => true,
    closeBrowserSheet: () => {},
    submissionAuthority: { available: true, claim: async () => true },
    captureOrderBaseline: async () => ({ capturedAt: Date.now(), orderIds: [] }),
    runExclusive: async (fn) => fn(),
    isolationDeps: {
      navigateToCart: async () => {},
      scrapeCart: async () => ({
        signedIn: true,
        challenge: 'none',
        currentUrl: 'https://www.amazon.com/gp/cart/view.html',
        cartCount: 1,
        subtotalCents: 22999,
        items: [
          {
            asin: 'B09XS7JWHH',
            title: 'Sony WH-1000XM5',
            quantity: 1,
            unitPriceCents: 22999,
            imageUrl: null,
            inStock: true,
            seller: 'Amazon.com',
          },
        ],
      }),
      moveSavedToCart: async () => ({ mutated: false }),
      addTargetToCart: async () => ({ ok: true }),
      stepRowQuantity: async () => ({ mutated: true }),
      saveRowForLater: async () => ({ mutated: true }),
      waitMs: async () => {},
    },
    syncCartRowsToState: () => [],
    proceedToCheckoutAndInspect: async () => ({
      stage: 'checkout_review',
      signedIn: true,
      challenge: 'none',
      canPlaceOrder: true,
      subtotalCents: 22999,
      shippingCents: 0,
      taxCents: 1901,
      totalCents: 24900,
      summaryItemCount: 1,
      lineItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }],
      deliveryEstimate: 'Arriving Tomorrow',
      currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    }),
    submitCheckoutOrder: async () => {
      placeOrderClicked += 1;
      return { submitted: true, haltedBySafetyGate: false };
    },
    readConfirmation: async () => ({
      retailerOrderId: null,
      isConfirmationSurface: false,
      hasAuthOrErrorBarrier: false,
      currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    }),
    reconcileViaSyncOrders: async () => {
      const now = Date.now();
      if (!orderVisibleInYourOrders) {
        ledger.reconcileFromSyncedOrders([]);
        return { ok: true, requiresSignIn: false, purchases: [], syncedAt: now };
      }
      ledger.reconcileFromSyncedOrders([
        {
          retailerOrderId: '114-5556666-7778888',
          asin: 'B09XS7JWHH',
          items: [{ asin: 'B09XS7JWHH', quantity: 1 }],
          totalCents: 24900,
          placedAtPrecision: 'timestamp',
      placedAtMs: now,
          syncedAt: now,
        },
      ]);
      return { ok: true, requiresSignIn: false, purchases: [], syncedAt: now };
    },
    getPreExistingOrderIds: () => [],
    onOrderPlacedLocalState: async () => {},
    submissionLedger: ledger,
    syncQueue,
    convexSync: {
      recordClientPlacement: async (args) => {
        placementCalls.push(`${args.orderRef}:${args.retailerOrderId}`);
      },
      syncClientShipment: async () => {},
    },
    convexCoordinator: {
      findPendingApprovalForItem: async () => null,
      findExistingOrderForItem: async () => null,
      requestPurchase: async () => {
        requestPurchaseCount += 1;
        return {
          requestId: `req_retry_${requestPurchaseCount}`,
          status: 'pending_approval',
          quoteVersion: 1,
          expiresAt: Date.now() + 600_000,
          quote: null,
        };
      },
      attachClientQuote: async (args) => ({ quoteVersion: 2, quote: args.quote }),
      decidePurchase: async (args) => ({
        outcome: 'approved',
        request: {
          requestId: args.requestId,
          itemId: cartItem.id,
          offerId: cartItem.offer.id,
          status: 'approved',
          requestedBy: 'app',
          reason: 'Retry test',
          quantity: 1,
          quoteVersion: 2,
          quote: null,
          expiresAt: Date.now() + 600_000,
          decidedAt: Date.now(),
          requestedAt: Date.now(),
          error: null,
          order: {
            orderId: 'ord_retry_1',
            orderRef: `CART-RETRY-${requestPurchaseCount}`,
            status: 'awaiting_client',
            retailerOrderId: null,
            placedAt: Date.now(),
            simulated: false,
          },
          shipment: null,
        },
      }),
    },
  });

  // Attempt 1: Confirmation & immediate Your Orders check both miss -> status="unknown"
  const first = await executeDeterministicItemCheckout(makeAttemptDeps());
  assert.equal(first.status, 'unknown');
  assert.equal(first.orderRef, 'CART-RETRY-1');
  assert.equal(requestPurchaseCount, 1);
  assert.equal(placeOrderClicked, 1);

  // Attempt 2 (caller retries WITHOUT orderRef while order still hasn't rendered in Your Orders):
  // MUST reuse CART-RETRY-1, MUST NOT call requestPurchase again, MUST NOT click #placeYourOrder!
  const second = await executeDeterministicItemCheckout(makeAttemptDeps());
  assert.equal(second.status, 'unknown');
  assert.equal(second.orderRef, 'CART-RETRY-1');
  assert.equal(second.safetyGate.orderSubmitted, false);
  assert.equal(requestPurchaseCount, 1);
  assert.equal(placeOrderClicked, 1);

  // Attempt 3 (order now visible in Your Orders, caller still omits orderRef):
  // Reconciles CART-RETRY-1 -> placed without clicking #placeYourOrder or minting a 2nd request!
  orderVisibleInYourOrders = true;
  const third = await executeDeterministicItemCheckout(makeAttemptDeps());
  assert.equal(third.status, 'placed');
  assert.equal(third.orderRef, 'CART-RETRY-1');
  assert.equal(third.retailerOrderId, '114-5556666-7778888');
  assert.equal(third.safetyGate.orderSubmitted, false);
  assert.equal(requestPurchaseCount, 1);
  assert.equal(placeOrderClicked, 1);
  assert.deepEqual(placementCalls, ['CART-RETRY-1:114-5556666-7778888']);

  // Session reset wipes per-item checkout bindings cleanly
  ledger.clear();
  assert.equal(ledger.getItemBinding(cartItem.id), undefined);
});

test('(k.2) [MEDIUM] executeCartSyncPlan inspects live Amazon cart on missing-ledger add_item and never double-adds present ASINs', async () => {
  const ledger = new SyncedCartLedger(undefined, 'shopper_dedup');
  await ledger.hydrate('shopper_dedup');

  const convexItems = [
    {
      id: 'item_already_exact',
      url: 'https://www.amazon.com/dp/B09XS7JWHH',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: 1_700_000_001_000,
    },
    {
      id: 'item_excess_in_amz',
      url: 'https://www.amazon.com/dp/B08N5WRWNW',
      status: 'active',
      quantity: 1,
      addedBy: 'agent',
      addedAt: 1_700_000_002_000,
    },
    {
      id: 'item_truly_missing',
      url: 'https://www.amazon.com/dp/B07FZ8S74R',
      status: 'active',
      quantity: 2,
      addedBy: 'agent',
      addedAt: 1_700_000_003_000,
    },
  ];

  const actions = planConvexCartSyncActions({
    activeItems: convexItems,
    ledger,
    isSignedIn: true,
    now: 1_700_000_010_000,
  });
  assert.equal(actions.every((a) => a.kind === 'add_item'), true);

  const ops = [];
  await executeCartSyncPlan({
    actions,
    ledger,
    isSignedIn: true,
    now: () => 1_700_000_010_000,
    refreshCart: async () => {
      ops.push('refreshCart');
      return [
        {
          id: 'amz-item-B09XS7JWHH',
          url: 'https://www.amazon.com/dp/B09XS7JWHH',
          status: 'active',
          quantity: 1,
          reason: null,
          addedBy: 'app',
          addedAt: 1_700_000_000_000,
          enrichmentStatus: 'ready',
          product: null,
          variant: null,
          offer: null,
          offers: [],
          rating: null,
          price: null,
          priceHistory: null,
        },
        {
          id: 'amz-item-B08N5WRWNW',
          url: 'https://www.amazon.com/dp/B08N5WRWNW',
          status: 'active',
          quantity: 2,
          reason: null,
          addedBy: 'app',
          addedAt: 1_700_000_000_000,
          enrichmentStatus: 'ready',
          product: null,
          variant: null,
          offer: null,
          offers: [],
          rating: null,
          price: null,
          priceHistory: null,
        },
      ];
    },
    addToCart: async (input) => {
      ops.push(`addToCart:${input.asin}:${input.quantity}`);
      return { ok: true, syncedAt: 1_700_000_010_000 };
    },
    setQuantity: async (args) => {
      ops.push(`setQuantity:${args.itemId}:${args.quantity}`);
      return null;
    },
  });

  // 1. refreshCart ran once for the batch;
  // 2. B07FZ8S74R (newest agent item, live qty 0) -> addToCart qty 2!
  // 3. B08N5WRWNW (live qty 2 !== target 1) -> setQuantity down to 1 (NOT addToCart)!
  // 4. B09XS7JWHH (live qty 1 === target 1) -> ZERO mutations!
  assert.deepEqual(ops, [
    'refreshCart',
    'addToCart:B07FZ8S74R:2',
    'setQuantity:B08N5WRWNW:1',
  ]);
  assert.equal(ledger.get('item_already_exact')?.quantity, 1);
  assert.equal(ledger.get('item_excess_in_amz')?.quantity, 1);
  assert.equal(ledger.get('item_truly_missing')?.quantity, 2);
});

test('(k.3) [MEDIUM] immediate reconcileViaSyncOrders executes strictly inside runExclusive before queued WebView commands run', async () => {
  const timeline = [];
  let fifoChain = Promise.resolve();
  const enqueueCommand = (task) => {
    const next = fifoChain.then(task, task);
    fifoChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const cartItem = {
    id: 'item_serial_check',
    url: 'https://www.amazon.com/dp/B09XS7JWHH',
    status: 'active',
    quantity: 1,
    reason: null,
    addedBy: 'app',
    addedAt: 1_700_000_000_000,
    enrichmentStatus: 'ready',
    product: null,
    variant: null,
    offer: null,
    offers: [],
    rating: null,
    price: null,
    priceHistory: null,
  };

  const checkoutPromise = executeDeterministicItemCheckout({
    input: { item: cartItem, dryRun: false, userConfirmed: true },
    isSignedIn: () => true,
    ensureSignedIn: async () => true,
    closeBrowserSheet: () => {},
    submissionAuthority: { available: true, claim: async () => true },
    captureOrderBaseline: async () => ({ capturedAt: Date.now(), orderIds: [] }),
    runExclusive: (fn) => enqueueCommand(fn),
    isolationDeps: {
      navigateToCart: async () => {
        timeline.push('checkout:nav_cart');
      },
      scrapeCart: async () => ({
        signedIn: true,
        challenge: 'none',
        currentUrl: 'https://www.amazon.com/gp/cart/view.html',
        cartCount: 1,
        subtotalCents: 22999,
        items: [
          {
            asin: 'B09XS7JWHH',
            title: 'Sony WH-1000XM5',
            quantity: 1,
            unitPriceCents: 22999,
            imageUrl: null,
            inStock: true,
            seller: 'Amazon.com',
          },
        ],
      }),
      moveSavedToCart: async () => ({ mutated: false }),
      addTargetToCart: async () => ({ ok: true }),
      stepRowQuantity: async () => ({ mutated: true }),
      saveRowForLater: async () => ({ mutated: true }),
      waitMs: async () => {},
    },
    syncCartRowsToState: () => [],
    proceedToCheckoutAndInspect: async () => ({
      stage: 'checkout_review',
      signedIn: true,
      challenge: 'none',
      canPlaceOrder: true,
      subtotalCents: 22999,
      shippingCents: 0,
      taxCents: 1901,
      totalCents: 24900,
      summaryItemCount: 1,
      lineItems: [{ asin: 'B09XS7JWHH', title: 'Sony WH-1000XM5', quantity: 1 }],
      deliveryEstimate: 'Tomorrow',
      currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
    }),
    submitCheckoutOrder: async () => {
      timeline.push('checkout:submit');
      return { submitted: true, haltedBySafetyGate: false };
    },
    readConfirmation: async () => {
      timeline.push('checkout:read_confirmation_unknown');
      return {
        retailerOrderId: null,
        isConfirmationSurface: false,
        hasAuthOrErrorBarrier: false,
        currentUrl: 'https://www.amazon.com/gp/buy/spc/handlers/display.html',
      };
    },
    reconcileViaSyncOrders: async () => {
      timeline.push('checkout:reconcile_start');
      await new Promise((r) => setTimeout(r, 15));
      timeline.push('checkout:reconcile_end');
      return { ok: true, requiresSignIn: false, purchases: [], syncedAt: Date.now() };
    },
    getPreExistingOrderIds: () => [],
    onOrderPlacedLocalState: async () => {},
    submissionLedger: new OrderSubmissionLedger(),
    syncQueue: new ConvexSyncRetryQueue(),
    convexSync: null,
    convexCoordinator: null,
  });

  // Queue a second browser command immediately while checkout is running
  const secondQueuedCommand = enqueueCommand(async () => {
    timeline.push('second_command:start');
  });

  await Promise.all([checkoutPromise, secondQueuedCommand]);

  assert.deepEqual(timeline, [
    'checkout:nav_cart',
    'checkout:submit',
    'checkout:read_confirmation_unknown',
    'checkout:reconcile_start',
    'checkout:reconcile_end',
    'second_command:start',
  ]);
});

