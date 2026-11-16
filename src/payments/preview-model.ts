import type { AccountBalance } from './model';
import { isSandboxDemo, providerBalance, type WhopAccountPayload } from './whop-adapter';

export function isWhopPreviewEnvironment(environment: unknown): boolean {
  return environment === 'development' || environment === 'preview';
}

export type WhopPreviewModel = {
  linked: boolean;
  maskedDigits: string;
  balance: AccountBalance | null;
};

export function whopPreviewModel(account: WhopAccountPayload | null = null, mappingAuthorized = false): WhopPreviewModel {
  if (!mappingAuthorized || !account || !isSandboxDemo(account)) {
    return { linked: false, maskedDigits: '•••• 0000', balance: null };
  }
  const last4 = account.card?.last4;
  const validCard = account.card?.simulated === true && typeof last4 === 'string'
    && /^\d{4}$/.test(last4) && account.card.maskedCard === `•••• ${last4}`;
  return {
    linked: true,
    maskedDigits: validCard ? `•••• ${last4}` : '•••• 0000',
    balance: { ...providerBalance(account), ownershipConfirmed: true },
  };
}
