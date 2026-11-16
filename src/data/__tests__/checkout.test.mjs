import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../checkout.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

const identitySource = readFileSync(new URL('../offer-identity.ts', import.meta.url), 'utf8');
const identityCompiled = ts.transpileModule(identitySource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const extractAsin = (url) => url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? null;

function loadOfferIdentity() {
  const exports = {};
  const modules = { '@/amazon': { extractAsin }, '@/lib/format': { formatPrice: (cents) => `${(cents / 100).toFixed(2)}` } };
  vm.runInNewContext(identityCompiled, { exports, URL, require: (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`);
    return modules[name];
  } });
  return exports;
}

function checkoutHarness({ platform = 'ios', live = true, execute } = {}) {
  const attempts = [];
  const fallback = [];
  let opened = 0;
  const references = [];
  let cursor = 0;
  const modules = {
    react: {
      useCallback: (callback) => callback,
      useRef: (initial) => references[cursor++] ??= { current: initial },
    },
    'react-native': { Platform: { OS: platform } },
    '@/amazon': {
      extractAsin,
      useAmazonSession: () => ({
        checkoutAmazonItem: async (input) => {
          attempts.push(input);
          return execute ? execute(input) : { status: 'dry_run_halted', safetyGate: { orderSubmitted: false } };
        },
        openBrowserSheet: () => { opened += 1; },
      }),
    },
    './offer-identity': loadOfferIdentity(),
    './shop-store': { useShop: () => ({ live, checkoutItem: async (item) => { fallback.push(item); } }) },
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (name) => {
    assert.ok(Object.hasOwn(modules, name), `Unexpected module: ${name}`);
    return modules[name];
  } });
  return {
    render: () => { cursor = 0; return exports.useCheckout(); },
    attempts,
    fallback,
    get opened() { return opened; },
  };
}

const item = { id: 'cart-item-1', url: 'https://www.amazon.com/dp/B09XS7JWHH', offer: { retailer: 'amazon' } };

for (const platform of ['ios', 'android']) {
  test(`${platform}: every Amazon attempt explicitly enables dry-run and never falls back to approval`, async () => {
    const harness = checkoutHarness({ platform });
    const checkout = harness.render();
    for (let tap = 0; tap < 2; tap += 1) {
      assert.equal(await checkout(item), 'preview');
    }
    assert.equal(harness.attempts.length, 2);
    assert.ok(harness.attempts.every((input) => input.dryRun === true && input.item === item));
    assert.equal(harness.fallback.length, 0);
  });
}

test('an ASIN URL routes to dry-run even before retailer enrichment', async () => {
  const harness = checkoutHarness();
  assert.equal(await harness.render()({ ...item, offer: null }), 'preview');
  assert.equal(harness.attempts[0].dryRun, true);
  assert.equal(harness.fallback.length, 0);
});

test('repeated taps during sign-in completion use one dry-run attempt, including after rerender', async () => {
  let finish;
  const harness = checkoutHarness({ execute: () => new Promise((resolve) => { finish = resolve; }) });
  const first = harness.render()(item);
  await assert.rejects(harness.render()(item), /already being placed/);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].dryRun, true);
  finish({ status: 'dry_run_halted', safetyGate: { orderSubmitted: false } });
  assert.equal(await first, 'preview');
  assert.equal(harness.fallback.length, 0);
});

test('an uncertain failure is surfaced once without retry or fallback approval', async () => {
  const harness = checkoutHarness({ execute: async () => { throw new Error('Browser acknowledgement lost'); } });
  await assert.rejects(harness.render()(item), /acknowledgement lost/);
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].dryRun, true);
  assert.equal(harness.fallback.length, 0);
});

test('dismissed sign-in stays dismissed; a mid-checkout challenge can reopen the sheet', async () => {
  for (const [reason, opened] of [['Sign-in sheet was closed', 0], ['Amazon requires MFA', 1]]) {
    const harness = checkoutHarness({ execute: async () => ({ status: 'requires_signin', reason }) });
    await assert.rejects(harness.render()(item), /Finish signing in/);
    assert.equal(harness.opened, opened);
    assert.equal(harness.attempts[0].dryRun, true);
    assert.equal(harness.fallback.length, 0);
  }
});

test('web, offline demo, and other retailers keep their existing checkout path', async () => {
  const cases = [
    [{ platform: 'web' }, item],
    [{ live: false }, item],
    [{}, { ...item, url: 'https://example.com/item', offer: { retailer: 'other' } }],
  ];
  for (const [options, selected] of cases) {
    const harness = checkoutHarness(options);
    assert.equal(await harness.render()(selected), 'purchased');
    assert.equal(harness.attempts.length, 0);
    assert.deepEqual(harness.fallback, [selected]);
  }
});

test('an unexpected placed result can never be classified as a preview or a purchase', async () => {
  const harness = checkoutHarness({ execute: async () => ({ status: 'placed' }) });
  await assert.rejects(harness.render()(item), /Unexpected Amazon preview response/);
  assert.equal(harness.fallback.length, 0);
  assert.equal(harness.attempts.length, 1);
});

test('a dry-run response that reports submission is rejected', async () => {
  const harness = checkoutHarness({ execute: async () => ({
    status: 'dry_run_halted', safetyGate: { orderSubmitted: true },
  }) });
  await assert.rejects(harness.render()(item), /Unexpected Amazon preview response/);
  assert.equal(harness.fallback.length, 0);
});

test('the actual Cart callback keeps preview items in Cart and never emits a purchase success toast', async () => {
  const cart = readFileSync(new URL('../../app/(tabs)/index.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('index.tsx', cart, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'checkout') callback = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(callback);
  const actual = ts.transpileModule(`exports.checkout = ${callback.getText(ast)}`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const changes = [];
  const toasts = [];
  const unpinned = [];
  vm.runInNewContext(actual, {
    exports,
    inFlight: { current: new Set() },
    setCheckout: (id, state) => changes.push([id, state?.status]),
    checkoutItem: async () => 'preview',
    unpin: (id) => unpinned.push(id),
    setToast: (value) => toasts.push(value),
    errorMessage: (error) => error.message,
  });
  await exports.checkout(item);
  assert.deepEqual(changes, [[item.id, 'placing'], [item.id, 'preview']]);
  assert.deepEqual(toasts, [false]);
  assert.deepEqual(unpinned, []);
});

test('every app Amazon provider mount explicitly disables the backend daemon', () => {
  const layout = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('_layout.tsx', layout, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let mounts = 0;
  const visit = (node) => {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(ast) === 'AmazonBrowserProvider') {
      mounts += 1;
      const disabled = node.attributes.properties.find((attr) =>
        ts.isJsxAttribute(attr) && attr.name.getText(ast) === 'enableBackendDaemon');
      assert.ok(disabled?.initializer && ts.isJsxExpression(disabled.initializer));
      assert.equal(disabled.initializer.expression?.kind, ts.SyntaxKind.FalseKeyword);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(mounts, 1);
});

const listing = (overrides) => ({
  id: 'offer-black-used', retailer: 'amazon', variantId: 'variant-black', currency: 'USD', priceCents: 4000,
  url: 'https://www.amazon.com/dp/B000000001', ...overrides,
});

test('a fallback offer for another variant is refused before any Amazon basket action', async () => {
  const harness = checkoutHarness();
  const mismatched = {
    ...item,
    url: 'https://www.amazon.com/dp/B000000001',
    offer: listing({}),
    offerAvailability: { newOfferAvailable: true, note: 'Only used copies' },
    newOffer: listing({ id: 'offer-white-new', variantId: 'variant-white', priceCents: 2500, url: 'https://www.amazon.com/dp/B000000002' }),
  };
  await assert.rejects(harness.render()(mismatched), /can't match this item to one Amazon listing/);
  assert.equal(harness.attempts.length, 0);
  assert.equal(harness.fallback.length, 0);
});

test('a same-listing new offer keeps the dry-run preview path', async () => {
  const harness = checkoutHarness();
  const sameListing = {
    ...item,
    url: 'https://www.amazon.com/dp/B000000001',
    offer: listing({}),
    offerAvailability: { newOfferAvailable: true, note: null },
    newOffer: listing({ id: 'offer-black-new', priceCents: 4500 }),
  };
  assert.equal(await harness.render()(sameListing), 'preview');
  assert.equal(harness.attempts.length, 1);
  assert.equal(harness.attempts[0].dryRun, true);
});
