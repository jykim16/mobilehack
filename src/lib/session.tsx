import { useAuthActions, useConvexAuth, ConvexAuthProvider, type TokenStorage } from '@convex-dev/auth/react';
import { ConvexReactClient } from 'convex/react';
import * as SecureStore from 'expo-secure-store';
import { createContext, use, useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform } from 'react-native';

/**
 * Anonymous Convex Auth sign-in, per api-contract.md. Without EXPO_PUBLIC_CONVEX_URL the app runs
 * offline on mock data. With it, the app signs in once at launch in the background and the cart reads
 * live data once signed in; a failure is logged and surfaced as 'signed_out'.
 */

export type SessionStatus = 'offline' | 'signing_in' | 'signed_in' | 'signed_out';

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
      <AnonymousSignIn>{children}</AnonymousSignIn>
    </ConvexAuthProvider>
  );
}

function AnonymousSignIn({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { signIn } = useAuthActions();
  const attempted = useRef(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isLoading || isAuthenticated || attempted.current) return;
    attempted.current = true;
    signIn('anonymous').catch((error: unknown) => {
      console.warn('Anonymous sign-in failed.', error);
      setFailed(true);
    });
  }, [isLoading, isAuthenticated, signIn]);

  useEffect(() => {
    if (isAuthenticated) console.log('Signed in anonymously to Convex.');
  }, [isAuthenticated]);

  const status: SessionStatus = isAuthenticated ? 'signed_in' : failed ? 'signed_out' : 'signing_in';
  return <SessionContext value={status}>{children}</SessionContext>;
}

/** 'signed_in' once Convex Auth has a token; 'offline' when no backend URL is configured. */
export function useSession() {
  return use(SessionContext);
}
