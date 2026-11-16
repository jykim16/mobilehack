import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

import { OWNED_CART_MESSAGES, OwnedCartSync, ownedCartStorageKey } from '../owned-cart-sync.ts';

class InMemoryKeyValueStorage {
  map = new Map();
  getItem(key) { return this.map.get(key) ?? null; }
  setItem(key, value) { this.map.set(key, value); }
  removeItem(key) { this.map.delete(key); }
}

const ASIN = 'B09XS7JWHH';
const URL_A = 'https://www.amazon.com/dp/' + ASIN;

/** A mocked Amazon basket with the provider's applyOwnedCartDelta contract; it never checks out. */
function fakeAmazon(initial = {}) {
  const rows = new Map(Object.entries(initial).map(([asin, qty]) => [asin, Array.isArray(qty) ? qty : [qty]]));
  const calls = [];
  const engine = {
    connected: true,
    hook: null,
    canRun: () => engine.connected,
    qty: (asin) => (rows.get(asin) ?? []).reduce((sum, q) => sum + q, 0),
    setRows: (asin, list) => rows.set(asin, list),
    calls,
    applyDelta: async (input) => {
      calls.push(input);
      if (engine.hook) {
        const hooked = await engine.hook(input, engine);
        if (hooked) return hooked;
      }
      if (!engine.connected) return { kind: 'requires_signin', reason: 'signed out' };
      const list = rows.get(input.asin) ?? [];
      const before = engine.qty(input.asin);
      if (input.expectedLiveQty !== null && before !== input.expectedLiveQty) return { kind: 'drift', liveQty: before, rowCount: list.length };
      if (input.delta === 0) return { kind: 'observed', liveQty: before, rowCount: list.length };
      const target = before + input.delta;
      if (input.delta < 0 && (list.length !== 1 || target < 0)) return { kind: 'drift', liveQty: before, rowCount: list.length };
      if (target === 0) rows.delete(input.asin);
      else rows.set(input.asin, list.length ? [target] : [input.delta]);
      return { kind: 'mutated', beforeQty: before, afterQty: engine.qty(input.asin) };
    },
  };
  return engine;
}

async function setup({ initial, storage = new InMemoryKeyValueStorage(), shopper = 'shopper-a' } = {}) {
  const amazon = fakeAmazon(initial);
  const sync = new OwnedCartSync({ storage });
  sync.setEngine(amazon);
  await sync.hydrate(shopper);
  return { amazon, sync, storage };
}

const intent = (overrides = {}) => ({
  itemId: 'item-1', asin: ASIN, url: URL_A, title: 'Headphones', variantLabel: null, quantity: 1, create: true, ...overrides,
});

const settle = async (sync) => {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await sync.drain();
  }
};

test('an explicit add puts exactly one Cart-owned unit in Amazon; repeated taps do not add more', async () => {
  const { amazon, sync } = await setup();
  sync.setIntent(intent());
  sync.setIntent(intent());
  sync.setIntent(intent());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
  assert.equal(amazon.calls.filter((c) => c.delta !== 0).length, 1);
  assert.equal(sync.getItems()['item-1'].status, 'synced');
  assert.equal(sync.getItems()['item-1'].ownedQty, 1);
});

test('removing a Cart item removes only its owned unit and keeps a pre-existing same-ASIN unit', async () => {
  const { amazon, sync } = await setup({ initial: { [ASIN]: 1 } });
  sync.setIntent(intent());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 2);
  sync.setIntent(intent({ quantity: 0, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
  assert.deepEqual(amazon.calls.map((c) => [c.delta, c.expectedLiveQty]), [[1, null], [-1, 2]]);
  assert.equal(sync.getItems()['item-1'], undefined);
});

test('add then remove before the add starts never touches Amazon', async () => {
  const { amazon, sync } = await setup();
  amazon.connected = false;
  sync.setIntent(intent());
  sync.setIntent(intent({ quantity: 0, create: false }));
  amazon.connected = true;
  sync.resume();
  await settle(sync);
  assert.equal(amazon.calls.length, 0);
  assert.equal(amazon.qty(ASIN), 0);
  assert.deepEqual(sync.getItems(), {});
});

test('a remove issued while the add is in flight runs after it and converges to zero', async () => {
  const { amazon, sync } = await setup();
  let release;
  amazon.hook = (input) => (input.delta > 0 ? new Promise((resolve) => { release = resolve; }).then(() => null) : null);
  sync.setIntent(intent());
  await new Promise((resolve) => setImmediate(resolve));
  sync.setIntent(intent({ quantity: 0, create: false }));
  amazon.hook = null;
  release();
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 0);
  assert.deepEqual(amazon.calls.map((c) => c.delta), [1, -1]);
  assert.deepEqual(sync.getItems(), {});
});

test('an Amazon cart changed outside Cart is never mutated on removal; Cart shows an actionable notice', async () => {
  const { amazon, sync } = await setup();
  sync.setIntent(intent());
  await settle(sync);
  amazon.setRows(ASIN, [3]);
  sync.setIntent(intent({ quantity: 0, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 3);
  const state = sync.getItems()['item-1'];
  assert.equal(state.status, 'conflict');
  assert.equal(state.message, OWNED_CART_MESSAGES.driftRemove);
  assert.equal(state.ownedQty, 0);
});

test('duplicate Amazon rows for the ASIN are ambiguous: removal is refused', async () => {
  const { amazon, sync } = await setup();
  sync.setIntent(intent());
  await settle(sync);
  amazon.setRows(ASIN, [1, 0]);
  sync.setIntent(intent({ quantity: 0, create: false }));
  await settle(sync);
  assert.deepEqual(amazon.calls.at(-1).delta, -1);
  assert.equal(amazon.qty(ASIN), 1);
  assert.equal(sync.getItems()['item-1'].status, 'conflict');
});

test('an unknown add outcome is never retried blindly; Retry reconciles before acting', async () => {
  for (const [landed, expectedAdds] of [[true, 1], [false, 2]]) {
    const { amazon, sync } = await setup();
    amazon.hook = async (input, cart) => {
      if (input.delta !== 1) return null;
      amazon.hook = null;
      if (landed) cart.setRows(ASIN, [1]);
      return { kind: 'mutated', beforeQty: 0, afterQty: null, error: 'acknowledgement lost' };
    };
    sync.setIntent(intent());
    await settle(sync);
    assert.equal(sync.getItems()['item-1'].status, 'failed');
    assert.equal(sync.getItems()['item-1'].message, OWNED_CART_MESSAGES.unknown);
    const callsBeforeRetry = amazon.calls.length;
    sync.resume();
    await settle(sync);
    assert.equal(amazon.calls.length, callsBeforeRetry, 'no automatic retry');
    sync.retry('item-1');
    await settle(sync);
    assert.equal(amazon.calls.filter((c) => c.delta === 1).length, expectedAdds);
    assert.equal(amazon.qty(ASIN), 1);
    assert.equal(sync.getItems()['item-1'].status, 'synced');
    assert.equal(sync.getItems()['item-1'].ownedQty, 1);
  }
});

test('an unexpected after-quantity forfeits ownership instead of guessing', async () => {
  const { amazon, sync } = await setup();
  amazon.hook = async (input, cart) => {
    if (input.delta !== 1) return null;
    cart.setRows(ASIN, [2]);
    return { kind: 'mutated', beforeQty: 0, afterQty: 2 };
  };
  sync.setIntent(intent());
  await settle(sync);
  amazon.hook = null;
  assert.equal(sync.getItems()['item-1'].status, 'conflict');
  sync.setIntent(intent({ quantity: 0, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 2);
  assert.equal(amazon.calls.length, 1);
});

test('a network failure before any mutation waits for an explicit Retry', async () => {
  const { amazon, sync } = await setup();
  amazon.hook = async () => { amazon.hook = null; throw new Error('offline'); };
  sync.setIntent(intent());
  await settle(sync);
  assert.equal(sync.getItems()['item-1'].status, 'failed');
  assert.equal(amazon.qty(ASIN), 0);
  sync.resume();
  await settle(sync);
  assert.equal(amazon.calls.length, 1);
  sync.retry('item-1');
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
});

test('signed-out intents wait for sign-in and then converge', async () => {
  const { amazon, sync } = await setup();
  amazon.connected = false;
  sync.setIntent(intent());
  await settle(sync);
  assert.equal(amazon.calls.length, 0);
  assert.equal(sync.getItems()['item-1'].status, 'pending');
  amazon.connected = true;
  sync.resume();
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
});

test('sign-out or reset mid-flight drops the late callback and clears persisted ownership', async () => {
  const storage = new InMemoryKeyValueStorage();
  const { amazon, sync } = await setup({ storage });
  let release;
  amazon.hook = () => new Promise((resolve) => { release = resolve; });
  sync.setIntent(intent());
  await new Promise((resolve) => setImmediate(resolve));
  await sync.reset('shopper-a');
  release({ kind: 'mutated', beforeQty: 0, afterQty: 1 });
  await settle(sync);
  assert.deepEqual(sync.getItems(), {});
  assert.equal(storage.getItem(ownedCartStorageKey('shopper-a')), null);
});

test('account switch never carries ownership or intents to another shopper', async () => {
  const storage = new InMemoryKeyValueStorage();
  const { amazon, sync } = await setup({ storage });
  sync.setIntent(intent());
  await settle(sync);
  await sync.reset('shopper-b');
  assert.deepEqual(sync.getItems(), {});
  sync.setIntent(intent({ quantity: 0, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1, 'shopper B cannot remove shopper A\'s unit');
  assert.equal(storage.getItem(ownedCartStorageKey('shopper-a')), null);
});

test('ownership survives an app restart for the same shopper; an interrupted run resumes as pending', async () => {
  const storage = new InMemoryKeyValueStorage();
  const first = await setup({ storage });
  first.sync.setIntent(intent());
  await settle(first.sync);
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = new OwnedCartSync({ storage });
  restarted.setEngine(first.amazon);
  await restarted.hydrate('shopper-a');
  assert.equal(restarted.getItems()['item-1'].ownedQty, 1);
  restarted.setIntent(intent({ quantity: 0, create: false }));
  await settle(restarted);
  assert.equal(first.amazon.qty(ASIN), 0);
});

test('quantity changes move only the Cart-owned delta; untracked items are never adopted', async () => {
  const { amazon, sync } = await setup({ initial: { [ASIN]: 2 } });
  sync.setIntent(intent());
  await settle(sync);
  sync.setIntent(intent({ quantity: 3, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 5);
  sync.setIntent(intent({ quantity: 1, create: false }));
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 3);
  sync.setIntent(intent({ itemId: 'untracked', quantity: 4, create: false }));
  sync.setIntent(intent({ itemId: 'untracked', quantity: 0, create: false }));
  await settle(sync);
  assert.equal(sync.getItems().untracked, undefined);
  assert.equal(amazon.qty(ASIN), 3);
});

test('the provider adapter only reads and edits basket rows: no checkout, submission, or daemon path', () => {
  const source = readFileSync(new URL('../AmazonBrowserProvider.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('AmazonBrowserProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'applyOwnedCartDelta') body = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(body);
  for (const forbidden of [
    'buildSubmitCheckoutOrderScript', 'buildClickProceedToCheckoutScript', 'buildInspectCheckoutReviewScript',
    'placeOrder', 'checkoutAmazonItem', 'decidePurchase', 'requestPurchase', 'save_for_later', 'syncOrders', 'flushPendingSync',
  ]) {
    assert.ok(!body.includes(forbidden), forbidden + ' must not be reachable from Cart sync');
  }
  assert.match(source, /enableBackendDaemon = false/);
});
