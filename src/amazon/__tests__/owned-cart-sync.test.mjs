import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
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
  sync.setIntent(intent(), sync.scope());
  sync.setIntent(intent(), sync.scope());
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
  assert.equal(amazon.calls.filter((c) => c.delta !== 0).length, 1);
  assert.equal(sync.getItems()['item-1'].status, 'synced');
  assert.equal(sync.getItems()['item-1'].ownedQty, 1);
});

test('removing a Cart item removes only its owned unit and keeps a pre-existing same-ASIN unit', async () => {
  const { amazon, sync } = await setup({ initial: { [ASIN]: 1 } });
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 2);
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1);
  assert.deepEqual(amazon.calls.map((c) => [c.delta, c.expectedLiveQty]), [[1, null], [-1, 2]]);
  assert.equal(sync.getItems()['item-1'], undefined);
});

test('add then remove before the add starts never touches Amazon', async () => {
  const { amazon, sync } = await setup();
  amazon.connected = false;
  sync.setIntent(intent(), sync.scope());
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
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
  sync.setIntent(intent(), sync.scope());
  await new Promise((resolve) => setImmediate(resolve));
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
  amazon.hook = null;
  release();
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 0);
  assert.deepEqual(amazon.calls.map((c) => c.delta), [1, -1]);
  assert.deepEqual(sync.getItems(), {});
});

test('an Amazon cart changed outside Cart is never mutated on removal; Cart shows an actionable notice', async () => {
  const { amazon, sync } = await setup();
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  amazon.setRows(ASIN, [3]);
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 3);
  const state = sync.getItems()['item-1'];
  assert.equal(state.status, 'conflict');
  assert.equal(state.message, OWNED_CART_MESSAGES.driftRemove);
  assert.equal(state.ownedQty, 0);
});

test('duplicate Amazon rows for the ASIN are ambiguous: removal is refused', async () => {
  const { amazon, sync } = await setup();
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  amazon.setRows(ASIN, [1, 0]);
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
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
    sync.setIntent(intent(), sync.scope());
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
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  amazon.hook = null;
  assert.equal(sync.getItems()['item-1'].status, 'conflict');
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 2);
  assert.equal(amazon.calls.length, 1);
});

test('a network failure before any mutation waits for an explicit Retry', async () => {
  const { amazon, sync } = await setup();
  amazon.hook = async () => { amazon.hook = null; throw new Error('offline'); };
  sync.setIntent(intent(), sync.scope());
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
  sync.setIntent(intent(), sync.scope());
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
  sync.setIntent(intent(), sync.scope());
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
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  await sync.reset('shopper-b');
  assert.deepEqual(sync.getItems(), {});
  sync.setIntent(intent({ quantity: 0, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1, 'shopper B cannot remove shopper A\'s unit');
  assert.equal(storage.getItem(ownedCartStorageKey('shopper-a')), null);
});

test('ownership survives an app restart for the same shopper; an interrupted run resumes as pending', async () => {
  const storage = new InMemoryKeyValueStorage();
  const first = await setup({ storage });
  first.sync.setIntent(intent(), first.sync.scope());
  await settle(first.sync);
  await new Promise((resolve) => setImmediate(resolve));
  const restarted = new OwnedCartSync({ storage });
  restarted.setEngine(first.amazon);
  await restarted.hydrate('shopper-a');
  assert.equal(restarted.getItems()['item-1'].ownedQty, 1);
  restarted.setIntent(intent({ quantity: 0, create: false }), restarted.scope());
  await settle(restarted);
  assert.equal(first.amazon.qty(ASIN), 0);
});

test('an app kill mid-dispatch is never replayed on restart: the ASIN is forfeited with a notice', async () => {
  for (const preExisting of [0, 1]) {
    const storage = new InMemoryKeyValueStorage();
    const first = await setup({ storage, initial: preExisting ? { [ASIN]: preExisting } : {} });
    let persistedAtDispatch = null;
    first.amazon.hook = (input, cart) => {
      persistedAtDispatch = storage.getItem(ownedCartStorageKey('shopper-a'));
      cart.setRows(ASIN, [preExisting + input.delta]);
      return new Promise(() => {});
    };
    first.sync.setIntent(intent(), first.sync.scope());
    await settle(first.sync);
    assert.ok(persistedAtDispatch?.includes('"syncing"'), 'syncing marker is durable before dispatch');

    const restoredStorage = new InMemoryKeyValueStorage();
    restoredStorage.setItem(ownedCartStorageKey('shopper-a'), persistedAtDispatch);
    const amazon = fakeAmazon({ [ASIN]: preExisting + 1 });
    const restarted = new OwnedCartSync({ storage: restoredStorage });
    restarted.setEngine(amazon);
    await restarted.hydrate('shopper-a');
    restarted.resume();
    await settle(restarted);
    assert.equal(amazon.calls.length, 0, 'no replayed dispatch');
    assert.equal(amazon.qty(ASIN), preExisting + 1);
    const state = restarted.getItems()['item-1'];
    assert.equal(state.status, 'conflict');
    assert.equal(state.ownedQty, 0);
    assert.equal(state.message, OWNED_CART_MESSAGES.interrupted);

    restarted.setIntent(intent({ quantity: 0, create: false }), restarted.scope());
    await settle(restarted);
    assert.equal(amazon.calls.length, 0, 'removal after an interrupted add never guesses ownership');
    assert.equal(amazon.qty(ASIN), preExisting + 1);
  }
});

test('an add whose backend request outlives a sign-out or shopper switch is dropped', async () => {
  const storage = new InMemoryKeyValueStorage();
  const { amazon, sync } = await setup({ storage });
  const capturedForA = sync.scope();
  await sync.reset('shopper-b');
  sync.setIntent(intent(), capturedForA);
  await settle(sync);
  assert.deepEqual(sync.getItems(), {});
  assert.equal(amazon.calls.length, 0);
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 1, 'a scope captured for the current shopper still works');
});

test('quantity changes move only the Cart-owned delta; untracked items are never adopted', async () => {
  const { amazon, sync } = await setup({ initial: { [ASIN]: 2 } });
  sync.setIntent(intent(), sync.scope());
  await settle(sync);
  sync.setIntent(intent({ quantity: 3, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 5);
  sync.setIntent(intent({ quantity: 1, create: false }), sync.scope());
  await settle(sync);
  assert.equal(amazon.qty(ASIN), 3);
  sync.setIntent(intent({ itemId: 'untracked', quantity: 4, create: false }), sync.scope());
  sync.setIntent(intent({ itemId: 'untracked', quantity: 0, create: false }), sync.scope());
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

/** Executes the actual provider applyOwnedCartDelta callback body against a mocked WebView basket. */
function providerDelta({ pages }) {
  const source = readFileSync(new URL('../AmazonBrowserProvider.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('AmazonBrowserProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'applyOwnedCartDelta') callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const js = ts.transpileModule('exports.run = ' + callback.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const log = { adds: [], mutations: [], reads: 0 };
  const exports = {};
  vm.runInNewContext(js, {
    exports,
    sessionBarrier: { epoch: 1, isLogoutPending: false, isCurrent: () => true },
    enqueueCommand: (fn) => fn(),
    ensureReadySessionEpoch: async () => 1,
    navigateTo: async () => {},
    AMAZON_CART_URL: 'https://www.amazon.com/gp/cart/view.html',
    buildScrapeCartScript: () => 'scrape',
    buildMutateCartRowScript: (_req, asin, op) => 'mutate:' + op,
    evalStep: async (build) => {
      const script = build('req');
      if (script === 'scrape') return pages[Math.min(log.reads++, pages.length - 1)];
      log.mutations.push(script);
      return { mutated: true };
    },
    runAddToCartUnlocked: async (input) => {
      log.adds.push(input.quantity);
      return { ok: true };
    },
    canonicalAmazonProductUrl: (asin) => 'https://www.amazon.com/dp/' + asin,
    extractAsin: (value) => (/^[A-Z0-9]{10}$/.test(value) ? value : null),
    syncCartRowsToState: () => [],
    delay: async () => {},
  });
  return { run: exports.run, log };
}

const page = (rows, extra = {}) => ({ signedIn: true, challenge: 'none', items: rows.map((quantity) => ({ asin: ASIN, quantity })), ...extra });
const input = (delta, expectedLiveQty = null) => ({ asin: ASIN, url: URL_A, variantLabel: null, delta, expectedLiveQty });

test('provider: a signed-out or challenge page after a removal is an unknown outcome, never a confirmed zero', async () => {
  for (const after of [page([], { signedIn: false }), page([], { challenge: 'captcha' })]) {
    const { run, log } = providerDelta({ pages: [page([1]), after] });
    const result = await run(input(-1, 1));
    assert.equal(log.mutations.length, 1);
    assert.equal(result.kind, 'mutated');
    assert.equal(result.afterQty, null);
  }
});

test('provider: an add onto existing units never asks the AOD path for an absolute quantity', async () => {
  const onto = providerDelta({ pages: [page([2]), page([5])] });
  const result = await onto.run(input(3, 2));
  assert.deepEqual(onto.log.adds, [1, 1, 1]);
  assert.deepEqual([result.beforeQty, result.afterQty], [2, 5]);
  const fresh = providerDelta({ pages: [page([]), page([3])] });
  await fresh.run(input(3));
  assert.deepEqual(fresh.log.adds, [3]);
});

test('provider: duplicate ASIN rows block every mutation, including adds', async () => {
  for (const delta of [1, -1]) {
    const { run, log } = providerDelta({ pages: [page([1, 1])] });
    const result = await run(input(delta));
    assert.equal(result.kind, 'drift');
    assert.deepEqual(log.adds, []);
    assert.deepEqual(log.mutations, []);
  }
});

test('Cart keeps pending or conflicted Amazon removals visible after the last item is removed', () => {
  const cart = readFileSync(new URL('../../app/(tabs)/index.tsx', import.meta.url), 'utf8');
  const emptyBranch = cart.match(/items\.length === 0 && adds\.length === 0[^?]*\?/)?.[0] ?? '';
  assert.match(emptyBranch, /removedSync\.length === 0/);
});
