import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

import { CheckoutNotPlaced, checkoutMessages, checkoutResult } from '../checkout-status.ts';

const order = { orderId: 'order', orderRef: 'CART-ORDER', status: 'placed', retailerOrderId: 'retailer-order', placedAt: 1000, simulated: false };
const source = readFileSync(new URL('../shop-store.tsx', import.meta.url), 'utf8');
const start = source.indexOf('function placementOf(');
const end = source.indexOf('\nconst countOf', start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(`${source.slice(start, end)}\nexport { placementOf };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function watchPlacement(initial) {
  let current = initial;
  let notify;
  let unsubscribed = false;
  const exports = {};
  vm.runInNewContext(compiled, { exports, setTimeout, clearTimeout, CheckoutNotPlaced, checkoutResult, api: { purchases: { getPurchaseStatus: 'get-status' } } });
  const promise = exports.placementOf({ watchQuery: () => ({
    localQueryResult: () => current,
    onUpdate: (callback) => { notify = callback; return () => { unsubscribed = true; }; },
  }) }, 'request');
  return { promise, update: (next) => { current = next; notify(); }, stopped: () => unsubscribed };
}

for (const status of ['awaiting_payment', 'awaiting_client', 'unknown', 'failed', 'requote_required']) {
  test(`${status} is not placement and ends the spinner`, async () => {
    const run = watchPlacement({ requestId: 'request', status: 'approved', order: { ...order, status, placedAt: null, retailerOrderId: null } });
    await assert.rejects(run.promise, (error) => error instanceof CheckoutNotPlaced && error.result !== 'placed');
    assert.equal(run.stopped(), true);
  });
}

test('paid without retailer placement is still unconfirmed', async () => {
  const run = watchPlacement({ requestId: 'request', status: 'approved', payment: { status: 'paid' }, order: { ...order, status: 'awaiting_client', placedAt: null, retailerOrderId: null } });
  await assert.rejects(run.promise, (error) => error.result === 'unconfirmed');
});

test('request ordered alone cannot synthesize success', async () => {
  const run = watchPlacement({ requestId: 'request', status: 'ordered', order: null });
  await assert.rejects(run.promise, (error) => error.result === 'unconfirmed');
});

test('placed without a retailer identifier or timestamp cannot succeed', () => {
  assert.equal(checkoutResult({ ...order, retailerOrderId: null }), 'unconfirmed');
  assert.equal(checkoutResult({ ...order, placedAt: null }), 'unconfirmed');
  assert.equal(checkoutResult({ ...order, placedAt: -1 }), 'unconfirmed');
});

test('only the matching request with placed order and retailer identifier succeeds', async () => {
  const run = watchPlacement({ requestId: 'request', status: 'ordered', order });
  await run.promise;
  assert.equal(run.stopped(), true);
  await assert.rejects(watchPlacement({ requestId: 'other', status: 'ordered', order }).promise, (error) => error.result === 'unconfirmed');
});

test('submitting waits for authoritative placement rather than reporting approval as success', async () => {
  const run = watchPlacement({ requestId: 'request', status: 'approved', order: { ...order, status: 'submitting', retailerOrderId: null, placedAt: null } });
  assert.equal(run.stopped(), false);
  run.update({ requestId: 'request', status: 'ordered', order });
  await run.promise;
  assert.equal(run.stopped(), true);
});

test('pending payment after submitting terminates with distinct payment-needed result', async () => {
  const run = watchPlacement({ requestId: 'request', status: 'approved', order: { ...order, status: 'submitting' } });
  run.update({ requestId: 'request', status: 'approved', order: { ...order, status: 'awaiting_payment', placedAt: null } });
  await assert.rejects(run.promise, (error) => error.result === 'payment_required' && error.message === checkoutMessages.payment_required);
});

test('existing explicitly simulated placement uses its own order reference', () => {
  assert.equal(checkoutResult({ ...order, simulated: true, retailerOrderId: null }), 'placed');
});

const cartSource = readFileSync(new URL('../../app/(tabs)/index.tsx', import.meta.url), 'utf8');
const checkoutStart = cartSource.indexOf('  const checkout = async (item: CartItem) => {');
const checkoutEnd = cartSource.indexOf('\n  const renderItem', checkoutStart);
assert.ok(checkoutStart > 0 && checkoutEnd > checkoutStart);
const cartCompiled = ts.transpileModule(`${cartSource.slice(checkoutStart, checkoutEnd)}\nexport { checkout };`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const result of ['payment_required', 'unconfirmed', 'failed']) {
  test(`${result} keeps the Cart item and never shows the Ordered toast`, async () => {
    const exports = {};
    const toasts = [];
    const unpinned = [];
    const states = [];
    vm.runInNewContext(cartCompiled, {
      exports, inFlight: { current: new Set() },
      checkoutItem: async () => { throw new CheckoutNotPlaced(result); },
      unpin: (id) => unpinned.push(id),
      setToast: (visible) => toasts.push(visible),
      setCheckout: (id, state) => states.push({ id, state }),
      errorMessage: (error) => error.message,
    });
    await exports.checkout({ id: 'item' });
    assert.deepEqual(unpinned, []);
    assert.equal(toasts.includes(true), false);
    assert.equal(states.at(-1).state.status, 'error');
    assert.equal(states.at(-1).state.message, checkoutMessages[result]);
  });
}
