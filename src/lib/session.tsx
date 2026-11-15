import { ConvexAuthProvider, useConvexAuth, type TokenStorage } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, type ReactNode } from 'react';
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
