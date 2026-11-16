export type TestUserCredentials = {
  email: string;
  password: string;
};

export function getTestUser(config: {
  enabled: string | undefined;
  environment: unknown;
  channel: string | null;
  development: boolean;
  email: string | undefined;
  password: string | undefined;
}): TestUserCredentials | null {
  if (config.enabled !== 'true' || config.environment === 'production' || config.channel === 'production') return null;
  const allowed = config.development
    || ['development', 'preview', 'web-preview'].includes(String(config.environment));
  const email = config.email?.trim().toLowerCase();
  if (!allowed || !email || !config.password || config.password.length < 8) return null;
  return { email, password: config.password };
}

type PasswordSignIn = (
  provider: 'password',
  params: TestUserCredentials & { flow: 'signIn' | 'signUp' }
) => Promise<{ signingIn: boolean }>;

export async function signInTestUser(signIn: PasswordSignIn, credentials: TestUserCredentials) {
  let result;
  try {
    result = await signIn('password', { ...credentials, flow: 'signIn' });
  } catch (error) {
    if (!(error instanceof Error && /\bInvalidAccountId\b/.test(error.message))) throw error;
    result = await signIn('password', { ...credentials, flow: 'signUp' });
  }
  if (!result.signingIn) throw new Error('Test user sign-in did not complete.');
}

export const TEST_USER_ITEM_URL = 'https://www.amazon.com/dp/B0F3PQHWTZ';
export const TEST_USER_SEED_KEY = 'test-user-xm6-v1';

export function isTestUserItem(url: string) {
  try {
    const parsed = new URL(url);
    return /(^|\.)amazon\.com$/i.test(parsed.hostname)
      && /\/(?:dp|gp\/product|product-reviews)\/B0F3PQHWTZ(?:\/|$)/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

export async function ensureTestUserItem(
  listItems: () => Promise<{ url: string }[]>,
  addItem: (args: { url: string; idempotencyKey: string }) => Promise<unknown>
) {
  const items = await listItems();
  if (items.some((item) => isTestUserItem(item.url))) return;
  await addItem({ url: TEST_USER_ITEM_URL, idempotencyKey: TEST_USER_SEED_KEY });
}
