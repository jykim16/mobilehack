import assert from 'node:assert/strict';
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
  verifyActiveBasketBinding,
  verifyCheckoutReviewBinding,
} from '../safety.ts';
import {
  buildInspectCheckoutReviewScript,
  buildMutateCartRowScript,
  buildScrapeCartScript,
  buildScrapeOrderConfirmationScript,
  buildScrapeProgressTrackerScript,
  buildSubmitCheckoutOrderScript,
} from '../scripts.ts';

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
  ledger.recordUnknown(orderRef, 1_700_000_000_000, ['B09XS7JWHH']);
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
