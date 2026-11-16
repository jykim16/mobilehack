import { ConvexAuthProvider, useAuthToken, useConvexAuth, type TokenStorage } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

/**
 * Convex Auth session, per api-contract.md. Without EXPO_PUBLIC_CONVEX_URL the app runs offline on mock
 * data with no login. With it, the session lives in SecureStore and the app shows the email/password
 * sign-in screen until the shopper is signed in.
 */

export type SessionStatus = 'offline' | 'loading' | 'signed_in' | 'signed_out';

const convexUrl = process.env.EXPO_PUBLIC_CONVEX_URL;
export const convexConfigured = Boolean(convexUrl);
const convex = convexUrl ? new ConvexReactClient(convexUrl, { unsavedChangesWarning: false }) : null;

const storage: TokenStorage | undefined =
  Platform.OS === 'web'
    ? undefined
    : { getItem: SecureStore.getItemAsync, setItem: SecureStore.setItemAsync, removeItem: SecureStore.deleteItemAsync };

const SessionContext = createContext<SessionStatus>('offline');

export function SessionProvider({ children }: { children: ReactNode }) {
  if (!convex) return <SessionContext value="offline">{children}</SessionContext>;
  return (
    <ConvexAuthProvider client={convex} storage={storage}>
      <AuthStatus>{children}</AuthStatus>
    </ConvexAuthProvider>
  );
}

function AuthStatus({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const status: SessionStatus = isLoading ? 'loading' : isAuthenticated ? 'signed_in' : 'signed_out';
  return <SessionContext value={status}>{children}</SessionContext>;
}

/** 'signed_in' once Convex Auth has a token; 'offline' when no backend URL is configured. */
export function useSession() {
  return use(SessionContext);
}

const EMAIL_KEY = 'cart.accountEmail';
let accountEmail: string | null = null;

/** Convex Auth exposes no profile query, so the app keeps the email the shopper signed in with. */
export async function rememberAccountEmail(email: string | null) {
  accountEmail = email;
  if (!storage) return;
  if (email) await SecureStore.setItemAsync(EMAIL_KEY, email);
  else await SecureStore.deleteItemAsync(EMAIL_KEY);
}

export function useAccountEmail() {
  const [email, setEmail] = useState(accountEmail);
  useEffect(() => {
    if (accountEmail || !storage) return;
    SecureStore.getItemAsync(EMAIL_KEY).then(setEmail);
  }, []);
  return email;
}

/** The signed-in shopper's Convex user id, from the auth token's subject (`userId|sessionId`); null when signed out. */
export function useShopperId() {
  const token = useAuthToken();
  if (!token) return null;
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    return typeof payload.sub === 'string' ? payload.sub.split('|')[0] : null;
  } catch {
    return null;
  }
}
