import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import vm from 'node:vm';

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
  buildInspectCheckoutReviewScript,
  buildMutateCartRowScript,
  buildScrapeCartScript,
  buildScrapeOrderConfirmationScript,
  buildScrapeProgressTrackerScript,
  buildScrapeYourOrdersScript,
  buildSubmitCheckoutOrderScript,
} from '../scripts.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
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
  selectVerifiedAddedCartItem,
  settleSubmittedOrderConfirmation,
  verifyFinalCartRowQuantity,
} = await import('../reconcile-sync.ts');

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
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 2. Historical order from an earlier month for the exact same ASIN + qty + total
    {
      retailerOrderId: '114-2222222-2222222',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
      placedAtMs: new Date('2026-10-01T12:00:00Z').getTime(),
      syncedAt: submittedAt + 5000,
    },
    // 3. Unparsed null ASIN
    {
      retailerOrderId: '114-3333333-3333333',
      asin: null,
      totalCents: 49800,
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 4. Wrong quantity (qty 1 instead of 2)
    {
      retailerOrderId: '114-4444444-4444444',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 1 }],
      totalCents: 49800,
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 5000,
    },
    // 5. Wrong total
    {
      retailerOrderId: '114-5555555-5555555',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 24900,
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
      placedAtMs: submittedAt,
      syncedAt: submittedAt + 10_000,
    },
    {
      retailerOrderId: '114-7777777-7777777',
      asin: 'B09XS7JWHH',
      items: [{ asin: 'B09XS7JWHH', quantity: 2 }],
      totalCents: 49800,
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
