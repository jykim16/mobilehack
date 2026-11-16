import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';

import { ensureTestUserItem, getTestUser, isTestUserItem, signInTestUser, testUserSession, TEST_USER_ITEM_URL, TEST_USER_SEED_KEY } from '../test-user.ts';

const credentials = { email: 'fixture@example.invalid', password: '*'.repeat(12) };
const config = { ...credentials, enabled: 'true', environment: 'preview', channel: 'preview', development: false };

test('only explicitly enabled non-production environments expose the shortcut', () => {
  assert.deepEqual(getTestUser(config), credentials);
  for (const environment of ['development', 'preview', 'web-preview']) {
    assert.ok(getTestUser({ ...config, environment, channel: null }));
  }
  assert.ok(getTestUser({ ...config, environment: undefined, channel: null, development: true }));
  for (const override of [
    { enabled: undefined }, { enabled: 'false' }, { enabled: '1' },
    { email: undefined }, { email: ' ' }, { password: undefined }, { password: '' }, { password: '*'.repeat(7) },
    { environment: undefined }, { environment: 'unknown' },
    { environment: 'production' }, { channel: 'production' },
    { environment: 'production', development: true }, { channel: 'production', development: true },
  ]) {
    assert.equal(getTestUser({ ...config, ...override }), null);
  }
});

test('signs into an existing test account without trying to create it', async () => {
  const calls = [];
  await signInTestUser(async (provider, params) => {
    assert.equal(provider, 'password');
    assert.equal(params.email, credentials.email);
    assert.equal(params.password, credentials.password);
    calls.push(params.flow);
    return { signingIn: true };
  }, credentials);
  assert.deepEqual(calls, ['signIn']);
});

test('creates the account only after InvalidAccountId', async () => {
  const calls = [];
  await signInTestUser(async (_provider, params) => {
    calls.push(params.flow);
    if (params.flow === 'signIn') throw new Error('Uncaught Error: InvalidAccountId');
    return { signingIn: true };
  }, credentials);
  assert.deepEqual(calls, ['signIn', 'signUp']);
});

test('wrong passwords, network errors, and incomplete auth never become signup', async () => {
  for (const message of ['InvalidSecret', 'Invalid credentials', 'Network unavailable', 'NotInvalidAccountId']) {
    let calls = 0;
    await assert.rejects(signInTestUser(async () => {
      calls++;
      throw new Error(message);
    }, credentials));
    assert.equal(calls, 1);
  }
  await assert.rejects(signInTestUser(async () => ({ signingIn: false }), credentials));
});

test('recognizes only matching Amazon product links', () => {
  for (const url of [TEST_USER_ITEM_URL, 'https://www.amazon.com/gp/product/B0F3PQHWTZ/ref=x', 'https://amazon.com/sony/dp/B0F3PQHWTZ?tag=x']) {
    assert.ok(isTestUserItem(url));
  }
  for (const url of ['not a URL', 'https://amazon.com.evil.invalid/dp/B0F3PQHWTZ', 'https://amazon.com/dp/B0F3PQHWTZ1', 'https://amazon.com/dp/OTHER']) {
    assert.equal(isTestUserItem(url), false);
  }
});

test('does not add an XM6 that is already present', async () => {
  await ensureTestUserItem(async () => [{ url: TEST_USER_ITEM_URL }], async () => assert.fail('must not add a duplicate'));
});

test('rerenders and concurrent mounts share one backend idempotency key', async () => {
  const inserted = new Map();
  const addItem = async ({ url, idempotencyKey }) => {
    assert.equal(url, TEST_USER_ITEM_URL);
    assert.equal(idempotencyKey, TEST_USER_SEED_KEY);
    if (!inserted.has(idempotencyKey)) inserted.set(idempotencyKey, url);
  };
  await Promise.all(Array.from({ length: 4 }, () => ensureTestUserItem(async () => [], addItem)));
  await ensureTestUserItem(async () => [...inserted.values()].map((url) => ({ url })), addItem);
  assert.equal(inserted.size, 1);
});

test('seed failures propagate without marking success', async () => {
  await assert.rejects(ensureTestUserItem(async () => { throw new Error('offline'); }, async () => assert.fail('must not add')));
  await assert.rejects(ensureTestUserItem(async () => [], async () => { throw new Error('offline'); }));
});

test('a session switch during the list request cancels the seed mutation', async () => {
  let active = true;
  let resolveItems;
  const items = new Promise((resolve) => { resolveItems = resolve; });
  const pending = ensureTestUserItem(() => items, async () => assert.fail('must not seed the next account'), () => active);
  active = false;
  resolveItems([]);
  await pending;
});

const tokenFor = (sub, issuedAt) => `fixture.${Buffer.from(JSON.stringify({ sub, iat: issuedAt })).toString('base64url')}.unsigned`;

test('same-session token refresh during the list request still seeds once', async () => {
  let token = tokenFor('demo-user|demo-session', 1);
  const session = testUserSession(token);
  let resolveItems;
  let additions = 0;
  const items = new Promise((resolve) => { resolveItems = resolve; });
  const pending = ensureTestUserItem(() => items, async () => { additions++; }, () => testUserSession(token) === session);
  token = tokenFor('demo-user|demo-session', 2);
  assert.equal(testUserSession(token), session);
  resolveItems([]);
  await pending;
  assert.equal(additions, 1);
});

test('new sessions, sign-out, and malformed tokens do not share a seed scope', () => {
  const session = testUserSession(tokenFor('demo-user|first-session', 1));
  assert.notEqual(testUserSession(tokenFor('demo-user|next-session', 2)), session);
  assert.notEqual(testUserSession(tokenFor('normal-user|other-session', 2)), session);
  for (const token of [null, '', 'invalid', 'fixture.e30.unsigned']) assert.equal(testUserSession(token), null);
});
