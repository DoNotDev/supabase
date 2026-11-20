// packages/providers/supabase/src/server/proxySession.ts

/**
 * @fileoverview Supabase session refresh for the Next proxy
 * @description The @supabase/ssr proxy pattern
 * (https://supabase.com/docs/guides/auth/server-side/creating-a-client?framework=nextjs,
 * example: https://github.com/supabase/supabase/blob/master/examples/auth/nextjs/lib/supabase/proxy.ts):
 * a server client on the request cookies verifies the session, refreshing an expired
 * access token: `getUser()` (Auth round trip) for documents, `getClaims()` (JWT signature
 * checked locally against the project's cached JWKS) for client-router fetches (RSC
 * soft navigations and prefetches). Refreshed or cleared cookies go on the forwarded
 * request (the server render reads them) and on the response (the browser keeps them).
 * The verdict is the only signed-in state the proxy redirects on.
 *
 * Structural request / response types: no dependency on `next`.
 *
 * @version 0.2.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */

import { createServerClient, createChunks, stringToBase64URL } from '@supabase/ssr';
import type { CookieOptions } from '@supabase/ssr';
import { isAuthRetryableFetchError } from '@supabase/supabase-js';
import type { AuthError, JwtPayload, User } from '@supabase/supabase-js';

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

/** Request headers the proxy reads (Next `NextRequest['headers']`). */
export interface ProxyRequestHeaders {
  get(name: string): string | null;
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
   * refresh failed, Auth rejects the user), `null` cannot tell (Supabase unreachable).
   * Same shape as the render's snapshot, bound to the verified user in forwarded cookies.
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

/**
 * Whether a proxy request is a client-router fetch (RSC soft navigation or prefetch),
 * not a document: a GET or HEAD whose Fetch Metadata `Sec-Fetch-Mode` is present and not
 * `navigate`. Next strips its own flight headers (`RSC`, `Next-Router-Prefetch`) from
 * the request the proxy sees (`FLIGHT_HEADERS` in next/dist/server/web/adapter.js,
 * unless `skipProxyUrlNormalize`), so the browser's header is the signal. Router fetches
 * are GETs; any other method may be a Server Action (`Next-Action`, or a multipart /
 * urlencoded form POST: `isMultipartAction` in next/dist/server/lib/server-action-request-meta.js)
 * and keeps `getUser()`. A request without Fetch Metadata (old browser, curl, crawler)
 * counts as a document: the stricter `getUser()` path.
 */
function isRouterFetch(request: {
  method: string;
  headers: ProxyRequestHeaders;
}): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const mode = request.headers.get('sec-fetch-mode');
  return mode !== null && mode !== 'navigate';
}

/** Session user bound to the forwarded render: the Auth user, or one rebuilt from verified claims. */
type VerifiedUser = Partial<User> & Pick<User, 'id'>;

/**
 * User of a client-router fetch, built from the verified JWT claims only: identity and
 * metadata as of the token's issue (at most one access-token lifetime old). Nothing comes
 * from the unsigned user in the cookie, so fields that are not claims (`email_confirmed_at`,
 * `created_at`, `identities`…) are absent: `emailVerified` reads false on these renders.
 * Render request only: never written to the browser's cookies (the browser client reads
 * its user from them).
 */
function userFromClaims(claims: JwtPayload): VerifiedUser {
  return {
    id: claims.sub,
    aud: Array.isArray(claims.aud) ? claims.aud[0] : claims.aud,
    role: claims.role,
    email: claims.email,
    phone: claims.phone,
    is_anonymous: claims.is_anonymous,
    app_metadata: claims.app_metadata ?? {},
    user_metadata: claims.user_metadata ?? {},
  };
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
 * Verification by request kind:
 * - Document (`Sec-Fetch-Mode: navigate`, or no Fetch Metadata) and any non-GET/HEAD
 *   request (Server Actions included): `getUser()`, one Auth round trip; the render gets
 *   the current user record.
 * - Client-router fetch (GET/HEAD, `Sec-Fetch-Mode` not `navigate`: RSC soft navigation,
 *   prefetch): `getClaims()`, the access token's signature checked locally against the
 *   project's JWKS (fetched once, cached 10 min per instance). Token not refreshed: the
 *   render gets a user built from the claims alone (metadata as of the token's issue: a
 *   profile change shows up within one access-token lifetime, or on the next document
 *   load; no `email_confirmed_at`) and the response writes no session cookie. Token
 *   refreshed in this request: render and browser get the user Auth's token endpoint
 *   returned (its id must be the claims' `sub`). A revoked session stays valid until
 *   the token expires. Only with
 *   asymmetric signing keys: a project still signing with the legacy HS256 secret makes
 *   `getClaims()` call Auth like `getUser()` (same verdict, no latency gain). Data access
 *   stays enforced by RLS.
 *
 * - Valid session: render cookies normalized to the verified user, signed in.
 * - Expired access token: refreshed by @supabase/ssr, new cookies on the request and
 *   the response, signed in. Refresh failure: @supabase/ssr clears the cookies, signed out.
 * - Session the server refuses: signed out; the auth cookies
 *   are dropped from the forwarded request so the render agrees (the browser client
 *   settles its own cookies).
 * - Supabase unreachable: cannot tell; browser cookies untouched, unverified auth
 *   cookies removed from the forwarded render request.
 *
 * "Remember me" off (session-only cookie present): rewritten auth cookies stay session
 * cookies, as in the browser client.
 *
 * @param request - The proxy request (Next `NextRequest`): cookies, and method + headers for the request kind
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
 * @version 0.2.0
 * @since 0.2.3
 */
export async function refreshSupabaseSession(
  request: {
    method: string;
    cookies: ProxyRequestCookies;
    headers: ProxyRequestHeaders;
  },
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

  // Documents: getUser validates with Auth and returns the current user record (fresh
  // metadata for the render). Client-router fetches: getClaims verifies the token's
  // signature locally and the forwarded user is built from the claims alone. The
  // cookie's unsigned user object is never forwarded on either path.
  let verified: { user: User } | { claims: JwtPayload } | null;
  let error: AuthError | null;
  if (isRouterFetch(request)) {
    const result = await supabase.auth.getClaims();
    verified = result.data ? { claims: result.data.claims } : null;
    error = result.error;
  } else {
    const result = await supabase.auth.getUser();
    verified = result.data.user ? { user: result.data.user } : null;
    error = result.error;
  }

  let session: AuthSessionSnapshot | null;
  if (verified) {
    const { data: stored, error: sessionError } = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (!stored.session) throw new Error('Verified Supabase session is missing');
    // A live session cookie write = the SDK refreshed the token during this request
    const sessionWrite = writes.find(({ name, options }) =>
      SUPABASE_SESSION_COOKIE.test(name) && options.maxAge !== 0
    );
    let user: VerifiedUser;
    if ('user' in verified) {
      user = verified.user;
    } else if (sessionWrite) {
      // Refreshed: the stored session's user is the one Auth's /token endpoint returned
      // in this request (auth-js _refreshAccessToken → _sessionResponse → _saveSession),
      // a full user record. It goes to the render and to the browser.
      if (stored.session.user.id !== verified.claims.sub) {
        throw new Error('Refreshed Supabase session user does not match the verified token');
      }
      user = stored.session.user;
    } else {
      // Not refreshed: the claims-only user goes to the render request only. No session
      // cookie is written to the response, so the browser keeps its own full user.
      user = userFromClaims(verified.claims);
    }

    // Bind the forwarded render identity to the verified result, not the unsigned
    // user serialized in the incoming cookie. Keep tokens/expiry from the SDK.
    const key = `sb-${new URL(url).hostname.split('.')[0]}-auth-token`;
    const encoded = `base64-${stringToBase64URL(JSON.stringify({
      ...stored.session,
      user,
    }))}`;
    for (const { name } of request.cookies.getAll()) {
      if (SUPABASE_SESSION_COOKIE.test(name)) request.cookies.delete(name);
    }
    const chunks = createChunks(key, encoded);
    for (const { name, value } of chunks) {
      request.cookies.set(name, value);
    }
    // Next also merges middleware response cookies into the render request.
    // A refresh write must carry this same verified user, not its older user copy.
    // Only refreshes write the response: a claims-only user never reaches the browser.
    if (sessionWrite) {
      for (let i = writes.length - 1; i >= 0; i--) {
        const write = writes[i];
        if (write && SUPABASE_SESSION_COOKIE.test(write.name) && write.options.maxAge !== 0) {
          if (chunks.some((chunk) => chunk.name === write.name)) {
            writes.splice(i, 1);
          } else {
            writes[i] = { name: write.name, value: '', options: { ...write.options, maxAge: 0 } };
          }
        }
      }
      for (const chunk of chunks) {
        writes.push({ ...chunk, options: sessionWrite.options });
      }
    }
    session = readSupabaseSessionCookie(cookieHeader(request.cookies));
  } else {
    const retryable = error && isAuthRetryableFetchError(error);
    session = retryable ? null : { user: null };
    // Next merges response cookies back into the render request too. A refresh
    // preceding failed verification must not restore the identity removed here.
    // Outages leave browser cookies untouched; definitive rejection clears writes.
    for (let i = writes.length - 1; i >= 0; i--) {
      const write = writes[i];
      if (write && SUPABASE_SESSION_COOKIE.test(write.name)) {
        if (retryable) writes.splice(i, 1);
        else writes[i] = { ...write, value: '', options: { ...write.options, maxAge: 0 } };
      }
    }
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
