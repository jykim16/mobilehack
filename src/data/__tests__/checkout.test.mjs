import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../checkout.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

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
      extractAsin: (url) => url.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? null,
      useAmazonSession: () => ({
        checkoutAmazonItem: async (input) => {
          attempts.push(input);
          return execute ? execute(input) : { status: 'dry_run_halted' };
        },
        openBrowserSheet: () => { opened += 1; },
      }),
    },
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
      await assert.rejects(checkout(item), /Stopped before placing/);
    }
    assert.equal(harness.attempts.length, 2);
    assert.ok(harness.attempts.every((input) => input.dryRun === true && input.item === item));
    assert.equal(harness.fallback.length, 0);
  });
}

test('an ASIN URL routes to dry-run even before retailer enrichment', async () => {
  const harness = checkoutHarness();
  await assert.rejects(harness.render()({ ...item, offer: null }), /Stopped before placing/);
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
  finish({ status: 'dry_run_halted' });
  await assert.rejects(first, /Stopped before placing/);
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
    await harness.render()(selected);
    assert.equal(harness.attempts.length, 0);
    assert.deepEqual(harness.fallback, [selected]);
  }
});
