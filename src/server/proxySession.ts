// packages/providers/supabase/src/server/proxySession.ts

/**
 * @fileoverview Supabase session refresh for the Next proxy
 * @description The @supabase/ssr proxy pattern
 * (https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs,
 * example: https://github.com/supabase/supabase/blob/master/examples/auth/nextjs/lib/supabase/proxy.ts):
 * a server client on the request cookies verifies the session with `getClaims()`,
 * refreshing an expired access token. Refreshed or cleared cookies go on the forwarded
 * request (the server render reads them) and on the response (the browser keeps them).
 * The verdict is the only signed-in state the proxy redirects on.
 *
 * Structural request / response types: no dependency on `next`.
 *
 * @version 0.1.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */

import { createServerClient } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';

import type { AuthSessionSnapshot } from '@donotdev/core';

import {
  SESSION_ONLY_COOKIE,
  SUPABASE_SESSION_COOKIE,
  readSupabaseSessionCookie,
} from '../common/sessionCookie';

/** Request cookies the proxy reads and rewrites (Next `NextRequest['cookies']`). */
export interface ProxyRequestCookies {
  getAll(): Array<{ name: string; value: string }>;
  set(name: string, value: string): unknown;
  delete(name: string): unknown;
}

/** Response the proxy returns (Next `NextResponse`): cookies and headers are written on it. */
export interface ProxyResponse {
  cookies: {
    set(name: string, value: string, options?: CookieOptions): unknown;
  };
  headers: { set(name: string, value: string): void };
}

/**
 * Verified session of a proxy request.
 *
 * @version 0.1.0
 * @since 0.2.3
 */
export interface SupabaseProxySession {
  /**
   * Signed-in state after verification: `{ user, accessToken? }` signed in with a
   * valid (possibly just refreshed) session, `{ user: null }` signed out (no session,
   * refresh failed, session revoked), `null` cannot tell (Supabase unreachable).
   * Same shape as the render's snapshot, read from the cookies forwarded to it.
   */
  session: AuthSessionSnapshot | null;
  /**
   * Write the refreshed / cleared auth cookies and the no-cache headers on the response
   * the proxy returns, whatever it is (next, rewrite, redirect). Skipping it on any
   * response loses a rotated refresh token and signs the visitor out.
   *
   * @param response - The proxy's response
   * @returns The same response
   */
  apply<R extends ProxyResponse>(response: R): R;
}

/**
 * Whether a request carries a Supabase auth cookie (`sb-<ref>-auth-token`, whole or
 * chunked). No cookie: the visitor is signed out, nothing to verify or refresh, and
 * the generated proxy serves the cached guest render. Name check only: the session
 * itself is verified by {@link refreshSupabaseSession}.
 *
 * @param request - The proxy request (Next `NextRequest`)
 * @returns `true` when an auth cookie is present
 *
 * @version 0.1.0
 * @since 0.2.3
 */
export function hasSupabaseSessionCookie(request: {
  cookies: Pick<ProxyRequestCookies, 'getAll'>;
}): boolean {
  return request.cookies
    .getAll()
    .some(({ name }) => SUPABASE_SESSION_COOKIE.test(name));
}

/** Cookie header of the request cookies, as readSupabaseSessionCookie reads it. */
function cookieHeader(cookies: ProxyRequestCookies): string {
  return cookies
    .getAll()
    .map(({ name, value }) => `${name}=${encodeURIComponent(value)}`)
    .join('; ');
}

/**
 * Verify, and refresh when expired, the Supabase session of a proxy request. Call it
 * once per request, before any redirect decision, then forward the request
 * (`NextResponse.next({ request })`, `NextResponse.rewrite(url, { request })`) and pass
 * every returned response through `apply`.
 *
 * - Valid session: unchanged cookies, signed in.
 * - Expired access token: refreshed by @supabase/ssr, new cookies on the request and
 *   the response, signed in. Refresh failure: @supabase/ssr clears the cookies, signed out.
 * - Session the server refuses (revoked, user deleted): signed out; the auth cookies
 *   are dropped from the forwarded request so the render agrees (the browser client
 *   settles its own cookies).
 * - Supabase unreachable: cannot tell, cookies untouched.
 *
 * "Remember me" off (session-only cookie present): rewritten auth cookies stay session
 * cookies, as in the browser client.
 *
 * @param request - The proxy request (Next `NextRequest`)
 * @param url - Project URL (`https://<ref>.supabase.co`)
 * @param publicKey - Publishable (or legacy anon) key
 * @returns The verdict and the response writer
 *
 * @example
 * ```ts
 * const auth = await refreshSupabaseSession(request, url, publicKey);
 * if (!auth.session?.user) return auth.apply(NextResponse.redirect(new URL('/login', request.url)));
 * return auth.apply(NextResponse.next({ request }));
 * ```
 *
 * @version 0.1.0
 * @since 0.2.3
 */
export async function refreshSupabaseSession(
  request: { cookies: ProxyRequestCookies },
  url: string,
  publicKey: string
): Promise<SupabaseProxySession> {
  const writes: Array<{ name: string; value: string; options: CookieOptions }> =
    [];
  const cacheHeaders: Record<string, string> = {};
  const sessionOnly = request.cookies
    .getAll()
    .some((cookie) => cookie.name === SESSION_ONLY_COOKIE);

  // A new client per request (cache headers come with its first cookie write only)
  const supabase = createServerClient(url, publicKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies, headers) => {
        for (const { name, value, options } of cookies) {
          const removal = options.maxAge === 0;
          if (removal) request.cookies.delete(name);
          else request.cookies.set(name, value);
          const { maxAge, expires, ...sessionOptions } = options;
          writes.push({
            name,
            value,
            options: sessionOnly && !removal ? sessionOptions : options,
          });
        }
        Object.assign(cacheHeaders, headers);
      },
    },
  });

  // No code between createServerClient and getClaims (Supabase docs). getClaims
  // verifies the JWT (JWKS, or getUser for symmetric keys) after getSession has
  // refreshed an expired one; never getSession alone on the server.
  const { data, error } = await supabase.auth.getClaims();

  let session: AuthSessionSnapshot | null;
  if (data?.claims) {
    session = readSupabaseSessionCookie(cookieHeader(request.cookies));
  } else if (error && isAuthRetryableFetchError(error)) {
    session = null;
  } else {
    session = { user: null };
    for (const { name } of request.cookies.getAll()) {
      if (SUPABASE_SESSION_COOKIE.test(name)) request.cookies.delete(name);
    }
  }

  return {
    session,
    apply(response) {
      for (const { name, value, options } of writes) {
        response.cookies.set(name, value, options);
      }
      for (const [key, value] of Object.entries(cacheHeaders)) {
        response.headers.set(key, value);
      }
      return response;
    },
  };
}
