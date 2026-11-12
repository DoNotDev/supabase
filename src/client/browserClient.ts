// packages/providers/supabase/src/client/browserClient.ts

/**
 * @fileoverview Supabase client with the session in cookies
 * @description `createBrowserClient` (@supabase/ssr) keeps the auth session in cookies
 * instead of localStorage, so the server can read who is signed in from the request
 * (SupabaseAuth.readSessionSnapshot) and render that state. The same call works during
 * server rendering (no session there, no token refresh).
 *
 * Remember me: @supabase/ssr writes every auth cookie with a long `maxAge` (persistent).
 * When the user opted out ({@link setSessionOnly}), the cookie writer here drops
 * `maxAge` / `expires`, so the auth cookies become session cookies, including the ones
 * rewritten on each token refresh. The choice is itself a session cookie, so it survives
 * OAuth redirects and ends with the browser session. Cookies the server rewrites on a
 * refresh (refreshSupabaseSession in the proxy) follow the same choice.
 *
 * @version 0.2.0
 * @since 0.1.46
 * @author AMBROISE PARK Consulting
 */

import {
  createBrowserClient as createSsrBrowserClient,
  parseCookieHeader,
  serializeCookieHeader,
} from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import { SESSION_ONLY_COOKIE } from '../common/sessionCookie';

/** Clients created here: their session lives in cookies. */
const cookieSessionClients = new WeakSet<object>();

const hasDocument = (): boolean => typeof document !== 'undefined';

function readCookies(): Array<{ name: string; value: string }> {
  if (!hasDocument()) return [];
  return parseCookieHeader(document.cookie).map(({ name, value }) => ({
    name,
    value: value ?? '',
  }));
}

function isSessionOnly(): boolean {
  return readCookies().some((cookie) => cookie.name === SESSION_ONLY_COOKIE);
}

/**
 * Choose how the next sign-in's session is kept: `true` = session cookies (gone when the
 * browser session ends), `false` = persistent cookies (the @supabase/ssr default).
 * Browser only.
 *
 * Limit: browsers that restore the previous session on restart also restore session
 * cookies; this is browser behaviour no site can override.
 *
 * @param sessionOnly - Whether to keep the session for this browser session only
 *
 * @version 0.1.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */
export function setSessionOnly(sessionOnly: boolean): void {
  document.cookie = sessionOnly
    ? serializeCookieHeader(SESSION_ONLY_COOKIE, '1', {
        path: '/',
        sameSite: 'lax',
      })
    : serializeCookieHeader(SESSION_ONLY_COOKIE, '', { path: '/', maxAge: 0 });
}

/**
 * Create the app's Supabase client with the auth session stored in cookies.
 * Use it instead of `createClient` in the app's provider setup; the server then knows
 * the signed-in state on the first render (no signed-out flash), and "remember me"
 * works ({@link setSessionOnly}).
 *
 * @param url - Project URL (`https://<ref>.supabase.co`)
 * @param publicKey - Publishable (or legacy anon) key
 *
 * @version 0.2.0
 * @since 0.1.46
 * @author AMBROISE PARK Consulting
 */
export function createBrowserClient(
  url: string,
  publicKey: string
): SupabaseClient {
  const client: SupabaseClient = createSsrBrowserClient(url, publicKey, {
    cookies: {
      getAll: readCookies,
      setAll: (cookies) => {
        if (!hasDocument()) return;
        const sessionOnly = isSessionOnly();
        for (const { name, value, options } of cookies) {
          // Removals (maxAge 0) stay removals; every other write becomes a session
          // cookie when the user chose not to be remembered.
          const removal = options.maxAge === 0;
          const { maxAge, expires, ...sessionOptions } = options;
          document.cookie = serializeCookieHeader(
            name,
            value,
            sessionOnly && !removal ? sessionOptions : options
          );
        }
      },
    },
  });
  cookieSessionClients.add(client);
  return client;
}

/** Whether the client keeps its session in cookies (created by createBrowserClient). */
export function hasCookieSession(client: SupabaseClient): boolean {
  return cookieSessionClients.has(client);
}
