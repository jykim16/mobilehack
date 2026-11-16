import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../offer-identity.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const modules = {
  '@/amazon': { extractAsin: (url) => url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] ?? null },
  '@/lib/format': { formatPrice: (cents) => '$' + (cents / 100).toFixed(2) },
};
const { resolveItemOffer, alternativeLine, amazonUrlAsin } = (() => {
  const exports = {};
  vm.runInNewContext(compiled, { exports, URL, require: (name) => modules[name] });
  return exports;
})();

const offer = (overrides) => ({
  id: 'black-used', retailer: 'amazon', retailerName: 'Amazon', variantId: 'black', variantLabel: 'Black',
  currency: 'USD', priceCents: 4000, url: 'https://www.amazon.com/dp/B000000001', ...overrides,
});
const white = offer({ id: 'white-new', variantId: 'white', variantLabel: 'White', priceCents: 2500, url: 'https://www.amazon.com/dp/B000000002' });
const base = { url: 'https://www.amazon.com/dp/B000000001', offer: offer({}) };

test('MOBI-35 fixture (legacy payload): a cheaper other-variant newOffer is never shown, bought, or targeted', () => {
  const resolved = resolveItemOffer({ ...base, newOffer: white, offerAvailability: { newOfferAvailable: true, note: 'Only used copies' } });
  assert.equal(resolved.offer.id, 'black-used');
  assert.equal(resolved.checkoutOffer, null);
  assert.equal(resolved.amazonAsin, null);
  assert.equal(resolved.alternative.id, 'white-new');
  assert.equal(alternativeLine(resolved.alternative), 'A different listing (White at Amazon) is $25.00.');
});

test('a same-listing new-condition offer is shown and is the only buyable identity', () => {
  const sameNew = offer({ id: 'black-new', priceCents: 4500 });
  const resolved = resolveItemOffer({ ...base, newOffer: sameNew, offerAvailability: { newOfferAvailable: true, note: null } });
  assert.equal(resolved.offer.id, 'black-new');
  assert.equal(resolved.checkoutOffer.id, 'black-new');
  assert.equal(resolved.amazonAsin, 'B000000001');
});

test('store, currency, or Amazon ASIN differences are alternatives, not replacements', () => {
  for (const candidate of [
    offer({ id: 'target', retailer: 'target', retailerName: 'Target', url: 'https://target.com/p/1' }),
    offer({ id: 'cad', currency: 'CAD' }),
    offer({ id: 'other-asin', url: 'https://www.amazon.com/dp/B000000009' }),
  ]) {
    const resolved = resolveItemOffer({ ...base, newOffer: candidate, offerAvailability: { newOfferAvailable: true, note: null } });
    assert.equal(resolved.checkoutOffer, null, candidate.id);
    assert.equal(resolved.offer.id, 'black-used', candidate.id);
    assert.equal(resolved.amazonAsin, null, candidate.id);
  }
});

test('backend #39 payload: null newOffer shows the saved offer, lists alternatives explicitly, and blocks checkout', () => {
  const resolved = resolveItemOffer({
    ...base,
    newOffer: null,
    offerAvailability: { newOfferAvailable: false, note: 'Only used copies', identityVerified: true, checkoutEligible: false },
    alternatives: [{ offerId: 'white-new', retailer: 'amazon', retailerName: 'Amazon', url: white.url, variantId: 'white', variantLabel: 'White', priceCents: 2500, currency: 'USD', sameVariant: false, sameRetailer: true, sameCurrency: true, reason: 'A different variant of this product' }],
  });
  assert.equal(resolved.offer.id, 'black-used');
  assert.equal(resolved.checkoutOffer, null);
  assert.equal(resolved.amazonAsin, null);
  assert.equal(resolved.alternative.variantLabel, 'White');
});

test('backend #39 flags are honored even when the client match would pass', () => {
  for (const flags of [{ checkoutEligible: false, identityVerified: true }, { checkoutEligible: true, identityVerified: false }]) {
    const resolved = resolveItemOffer({ ...base, newOffer: offer({}), offerAvailability: { newOfferAvailable: true, note: null, ...flags } });
    assert.equal(resolved.checkoutOffer, null);
    assert.equal(resolved.amazonAsin, null);
  }
  const eligible = resolveItemOffer({ ...base, newOffer: offer({}), offerAvailability: { newOfferAvailable: true, note: null, checkoutEligible: true, identityVerified: true } });
  assert.equal(eligible.checkoutOffer.id, 'black-used');
});

test('an Amazon offer whose ASIN differs from the pasted link is not targeted', () => {
  const resolved = resolveItemOffer({ url: 'https://www.amazon.com/dp/B000000003', offer: offer({}) });
  assert.equal(resolved.checkoutOffer.id, 'black-used');
  assert.equal(resolved.amazonAsin, null);
});

test('only amazon.com links yield an ASIN for Amazon cart sync', () => {
  assert.equal(amazonUrlAsin('https://www.amazon.com/dp/B09XS7JWHH'), 'B09XS7JWHH');
  assert.equal(amazonUrlAsin('https://smile.amazon.com/dp/B09XS7JWHH'), 'B09XS7JWHH');
  assert.equal(amazonUrlAsin('https://another-shop.example/product/B09XS7JWHH'), null);
  assert.equal(amazonUrlAsin('https://amazon.com.evil.example/dp/B09XS7JWHH'), null);
  assert.equal(amazonUrlAsin('not a url'), null);
  const resolved = resolveItemOffer({ url: 'https://another-shop.example/dp/B09XS7JWHH', offer: null });
  assert.equal(resolved.amazonAsin, null);
});
