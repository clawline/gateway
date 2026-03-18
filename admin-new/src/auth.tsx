/**
 * auth.tsx — Conditional Logto auth wrapper.
 *
 * Problem: Logto PKCE relies on Crypto.subtle, which browsers disable in
 *          insecure (non-HTTPS) contexts.  This breaks `http://` dev servers.
 *
 * Solution: Detect `window.isSecureContext`.
 *   • Secure (HTTPS / localhost): Normal LogtoProvider flow.
 *   • Insecure (HTTP):            Skip LogtoProvider entirely and inject a
 *                                  mock "already-authenticated" state so the
 *                                  admin UI renders without errors.
 */

import { createContext, useContext, type ReactNode } from 'react';
import { LogtoProvider, useLogto, type LogtoConfig } from '@logto/react';
import type { IdTokenClaims } from '@logto/react';

/* ------------------------------------------------------------------ */
/*  Secure-context detection                                          */
/* ------------------------------------------------------------------ */

export const isSecureContext =
  typeof window !== 'undefined' &&
  (window.isSecureContext || location.protocol === 'https:');

/* ------------------------------------------------------------------ */
/*  Shared auth interface consumed by the rest of the app             */
/* ------------------------------------------------------------------ */

export interface AuthContextValue {
  isAuthenticated: boolean;
  isLoading: boolean;
  signIn: (redirectUri: string) => Promise<void>;
  signOut: (postLogoutRedirectUri?: string) => Promise<void>;
  getIdTokenClaims: () => Promise<IdTokenClaims | undefined>;
  getAccessToken: (resource?: string) => Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/* ------------------------------------------------------------------ */
/*  Insecure-context mock provider                                    */
/* ------------------------------------------------------------------ */

const DEV_CLAIMS: IdTokenClaims = {
  sub: 'dev-local-user',
  name: 'Dev (HTTP bypass)',
  iss: 'local',
  aud: 'local',
  exp: Math.floor(Date.now() / 1000) + 86400,
  iat: Math.floor(Date.now() / 1000),
};

function InsecureAuthProvider({ children }: { children: ReactNode }) {
  const value: AuthContextValue = {
    isAuthenticated: true,
    isLoading: false,
    signIn: async () => {
      /* no-op in dev mode */
    },
    signOut: async (uri?: string) => {
      if (uri) window.location.href = uri;
    },
    getIdTokenClaims: async () => DEV_CLAIMS,
    getAccessToken: async () => {
      // Return empty string — backend legacy-admin-token fallback or
      // a dev-mode bypass on the server side should handle this.
      return '';
    },
  };

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Secure-context bridge (wraps real Logto)                          */
/* ------------------------------------------------------------------ */

function SecureAuthBridge({ children }: { children: ReactNode }) {
  const logto = useLogto();
  const value: AuthContextValue = {
    isAuthenticated: logto.isAuthenticated,
    isLoading: logto.isLoading,
    signIn: logto.signIn,
    signOut: logto.signOut,
    getIdTokenClaims: logto.getIdTokenClaims,
    getAccessToken: logto.getAccessToken,
  };
  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

/* ------------------------------------------------------------------ */
/*  Public API                                                        */
/* ------------------------------------------------------------------ */

export function AuthProvider({
  config,
  children,
}: {
  config: LogtoConfig;
  children: ReactNode;
}) {
  if (!isSecureContext) {
    console.warn(
      '[auth] Insecure context detected (HTTP). Logto SSO is bypassed — running in dev mode.',
    );
    return <InsecureAuthProvider>{children}</InsecureAuthProvider>;
  }

  return (
    <LogtoProvider config={config}>
      <SecureAuthBridge>{children}</SecureAuthBridge>
    </LogtoProvider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth() must be used within an <AuthProvider>');
  }
  return ctx;
}
