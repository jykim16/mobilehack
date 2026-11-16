import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { fixtureAccount } from './fixtures';
import { isWhopPreviewEnvironment, whopPreviewModel } from './preview-model';
import { ReadOnlyPaymentDetails } from './read-only-details';
import { WhopAccountCard } from './whop-account-card';

vi.mock('./whop-logo', () => ({ WhopLogo: () => createElement('span', { 'aria-label': 'Whop' }, 'Whop') }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => createElement('span') }));
vi.mock('@/components/order-details', () => ({ CloseButton: () => createElement('button', null, 'Close') }));
vi.mock('@/components/pill-button', () => ({ PillButton: () => createElement('button') }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }) }));

describe('read-only branded Whop preview', () => {
  it.each(['development', 'preview'])('shows in an explicit %s environment', (environment) => {
    expect(isWhopPreviewEnvironment(environment)).toBe(true);
  });
  it.each([undefined, null, '', 'production', 'staging', 'Preview'])('stays hidden for %s', (environment) => {
    expect(isWhopPreviewEnvironment(environment)).toBe(false);
  });
  it('defaults absent and unmapped accounts to no balance', () => {
    expect(whopPreviewModel()).toEqual({ linked: false, maskedDigits: '•••• 0000', balance: null });
    expect(whopPreviewModel(fixtureAccount)).toEqual(whopPreviewModel());
    expect(whopPreviewModel({ ...fixtureAccount, exists: false }, true)).toEqual(whopPreviewModel());
  });
  it('requires explicit mapping authorization and sandbox capabilities before reading amounts', () => {
    const account = { ...fixtureAccount, providerBalance: { ...fixtureAccount.providerBalance!, availableCents: -275, pendingCents: null } };
    expect(whopPreviewModel(account).balance).toBeNull();
    expect(whopPreviewModel(account, true).balance).toMatchObject({ availableCents: -275, pendingCents: null });
    expect(whopPreviewModel({ ...account, mode: 'whop_production' }, true).balance).toBeNull();
  });
  it('renders the unlinked card with official brand placeholder, synthetic digits, and only a details action', () => {
    const html = renderToStaticMarkup(createElement(WhopAccountCard, { model: whopPreviewModel(fixtureAccount), onDetails: () => {} }));
    expect(html).toContain('aria-label="Whop"');
    expect(html).toContain('0000');
    expect(html).toContain('Simulated card / Sandbox retailer charge');
    expect(html).toContain('Not a real issued or active card');
    expect(html).toContain('Account not linked');
    expect(html).toContain('Balance unavailable');
    expect(html).toContain('Payment details');
    expect(html).not.toContain('$45');
    expect(html).not.toContain('<input');
  });
  it('keeps the unlinked details page read-only without fixture controls or payment actions', () => {
    const html = renderToStaticMarkup(createElement(ReadOnlyPaymentDetails));
    expect(html).toContain('Balance unavailable');
    expect(html).toContain('does not check or start payments');
    expect(html).not.toContain('Approve and');
    expect(html).not.toContain('Refresh payment');
    expect(html).not.toContain('negative balance');
    expect(html).not.toContain('<input');
  });
});
