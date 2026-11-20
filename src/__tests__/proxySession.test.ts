// @vitest-environment node
// packages/providers/supabase/src/__tests__/proxySession.test.ts

/**
 * refreshSupabaseSession against the real @supabase/ssr server client and auth-js,
 * with the Supabase Auth API stubbed at `fetch`: the proxy's verdict, the cookies
 * forwarded to the render and the cookies written on the response.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { stringFromBase64URL, stringToBase64URL } from '@supabase/ssr';

import { readSupabaseSessionCookie } from '../common/sessionCookie';
import { refreshSupabaseSession } from '../server/proxySession';

const URL_ = 'https://abcdref.supabase.co';
const KEY = 'sb-abcdref-auth-token';
const now = () => Math.floor(Date.now() / 1000);

const user = {
  id: 'u1',
  aud: 'authenticated',
  role: 'authenticated',
  email: 'pro@example.com',
  email_confirmed_at: '2026-11-01T00:00:00Z',
  app_metadata: { role: 'user' },
  user_metadata: {},
  created_at: '2026-11-01T00:00:00Z',
};

/** HS256-shaped JWT (no kid: auth-js verifies it with getUser). */
function jwt(exp: number): string {
  const part = (o: object) => stringToBase64URL(JSON.stringify(o));
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub: 'u1', exp, role: 'authenticated', aud: 'authenticated' })}.c2ln`;
}

function sessionCookie(expiresAt: number): string {
  return `base64-${stringToBase64URL(
    JSON.stringify({
      access_token: jwt(expiresAt),
      refresh_token: 'refresh-1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      user,
    })
  )}`;
}

/** Fetch Metadata of a document request (address bar, link click without the client router). */
const DOCUMENT = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

/** Fetch Metadata of a client-router fetch (RSC soft navigation or prefetch). */
const ROUTER_FETCH = { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

/** NextRequest stand-in: cookies and headers (a document request by default). */
function request(
  cookies: Record<string, string>,
  headers: Record<string, string> = DOCUMENT,
  method = 'GET'
) {
  const jar = new Map(Object.entries(cookies));
  return {
    jar,
    method,
    headers: new Headers(headers),
    cookies: {
      getAll: () => [...jar].map(([name, value]) => ({ name, value })),
      set: (name: string, value: string) => jar.set(name, value),
      delete: (name: string) => jar.delete(name),
    },
  };
}

/** NextResponse stand-in. */
function response() {
  const set: Array<{
    name: string;
    value: string;
    options?: Record<string, unknown>;
  }> = [];
  return {
    set,
    cookies: {
      set: (name: string, value: string, options?: Record<string, unknown>) =>
        set.push({ name, value, options }),
    },
    headers: new Headers(),
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/** Stub the Auth API: `/token` (refresh), `/user` (getUser) and JWKS (getClaims) handlers. */
function authApi(handlers: {
  refresh?: () => Response | Promise<Response>;
  user?: () => Response | Promise<Response>;
  jwks?: () => Response | Promise<Response>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/auth/v1/token') && handlers.refresh)
      return handlers.refresh();
    if (url.includes('/auth/v1/user') && handlers.user) return handlers.user();
    if (url.includes('/auth/v1/.well-known/jwks.json') && handlers.jwks)
      return handlers.jwks();
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Session JSON inside the cookies the response writes. */
function writtenSession(set: ReturnType<typeof response>['set']) {
  const raw = set
    .filter((c) => c.name.startsWith(KEY) && c.value)
    .map((c) => c.value)
    .join('');
  return JSON.parse(stringFromBase64URL(raw.slice('base64-'.length)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('refreshSupabaseSession', () => {
  it('binds forwarded render identity and subscription to getUser, not a tampered cookie', async () => {
    const verified = { ...user, app_metadata: { role: 'user', subscription: {
      tier: 'free', status: 'active', subscriptionEnd: null, updatedAt: '2026-11-01T00:00:00.000Z',
    } } };
    authApi({ user: () => json(200, verified) });
    const expires = now() + 3600;
    const forged = JSON.parse(stringFromBase64URL(sessionCookie(expires).slice('base64-'.length)));
    forged.user = { ...user, id: 'victim', app_metadata: { role: 'super', subscription: {
      ...verified.app_metadata.subscription, tier: 'pro',
    } } };
    const req = request({ [KEY]: `base64-${stringToBase64URL(JSON.stringify(forged))}` });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    const forwarded = req.cookies.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
    const snapshot = readSupabaseSessionCookie(forwarded);
    expect(auth.session?.user).toMatchObject({ id: 'u1', role: 'user' });
    expect(snapshot?.user).toEqual(auth.session?.user);
    expect(snapshot?.userSubscription).toMatchObject({ userId: 'u1', tier: 'free' });
  });

  it('keeps a valid session: signed in, nothing rewritten', async () => {
    const fetchMock = authApi({ user: () => json(200, user) });
    const req = request({ [KEY]: sessionCookie(now() + 3600) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session?.user?.id).toBe('u1');
    expect(auth.session?.accessToken).toBe(jwt(now() + 3600));
    const res = auth.apply(response());
    expect(res.set).toEqual([]);
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('/token'))
    ).toBe(false);
  });

  it('refreshes an expired session: new cookies on the request and the response', async () => {
    const fresh = now() + 3600;
    authApi({
      refresh: () =>
        json(200, {
          access_token: jwt(fresh),
          refresh_token: 'refresh-2',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: fresh,
          user,
        }),
      user: () => json(200, user),
    });
    const req = request({ [KEY]: sessionCookie(now() - 60) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');

    expect(auth.session?.user?.id).toBe('u1');
    expect(auth.session?.accessToken).toBe(jwt(fresh));
    // The render reads the refreshed cookies forwarded with the request
    const forwarded = [...req.jar]
      .map(([n, v]) => `${n}=${encodeURIComponent(v)}`)
      .join('; ');
    expect(readSupabaseSessionCookie(forwarded)?.accessToken).toBe(jwt(fresh));

    const res = auth.apply(response());
    expect(writtenSession(res.set).refresh_token).toBe('refresh-2');
    expect(res.set.find((c) => c.value)?.options?.maxAge).toBeGreaterThan(0);
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('binds refreshed response cookies too: Next merges them into the render request', async () => {
    const fresh = now() + 3600;
    const refreshedUser = { ...user, user_metadata: { name: 'x'.repeat(12_000) }, app_metadata: { role: 'admin' } };
    authApi({
      refresh: () => json(200, {
        access_token: jwt(fresh), refresh_token: 'refresh-2', token_type: 'bearer',
        expires_in: 3600, expires_at: fresh, user: refreshedUser,
      }),
      user: () => json(200, user),
    });
    const req = request({ [KEY]: sessionCookie(now() - 60) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    const res = auth.apply(response());
    expect(writtenSession(res.set).user).toEqual(user);
    expect(auth.session?.user?.role).toBe('user');
    // The larger refresh response was chunked; stale chunks must be cleared.
    expect(res.set.some((write) => write.name.endsWith('.1') && write.options?.maxAge === 0)).toBe(true);
  });

  it('keeps refreshed cookies session-only when "remember me" was off', async () => {
    const fresh = now() + 3600;
    authApi({
      refresh: () =>
        json(200, {
          access_token: jwt(fresh),
          refresh_token: 'refresh-2',
          token_type: 'bearer',
          expires_in: 3600,
          expires_at: fresh,
          user,
        }),
      user: () => json(200, user),
    });
    const req = request({
      [KEY]: sessionCookie(now() - 60),
      'dndev-auth-session-only': '1',
    });
    const res = (await refreshSupabaseSession(req, URL_, 'key')).apply(
      response()
    );
    const writes = res.set.filter((c) => c.value);
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      expect(write.options?.maxAge).toBeUndefined();
      expect(write.options?.expires).toBeUndefined();
    }
  });

  it('signs out when the refresh token is dead: cookies cleared on both sides', async () => {
    authApi({
      refresh: () =>
        json(400, {
          code: 'refresh_token_not_found',
          error_code: 'refresh_token_not_found',
          msg: 'Invalid Refresh Token: Refresh Token Not Found',
        }),
    });
    const req = request({
      [KEY]: sessionCookie(now() - 60),
      'dndev-lang': 'fr',
    });
    const auth = await refreshSupabaseSession(req, URL_, 'key');

    expect(auth.session).toEqual({ user: null });
    expect([...req.jar.keys()]).toEqual(['dndev-lang']);
    const res = auth.apply(response());
    expect(res.set.find((c) => c.name === KEY)?.options?.maxAge).toBe(0);
  });

  it('signs out a session the server refuses; the render gets no auth cookie', async () => {
    authApi({
      user: () =>
        json(403, {
          code: 'session_not_found',
          error_code: 'session_not_found',
          msg: 'Session not found',
        }),
    });
    const req = request({ [KEY]: sessionCookie(now() + 3600) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session).toEqual({ user: null });
    expect(req.jar.has(KEY)).toBe(false);
  });

  it('does not let refreshed response cookies restore a render identity rejected by getUser', async () => {
    const fresh = now() + 3600;
    authApi({
      refresh: () => json(200, {
        access_token: jwt(fresh), refresh_token: 'refresh-2', token_type: 'bearer',
        expires_in: 3600, expires_at: fresh, user: { ...user, app_metadata: { role: 'admin' } },
      }),
      user: () => json(403, {
        code: 'session_not_found', error_code: 'session_not_found', msg: 'Session not found',
      }),
    });
    const req = request({ [KEY]: sessionCookie(now() - 60) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session).toEqual({ user: null });
    expect(req.jar.has(KEY)).toBe(false);
    const res = auth.apply(response());
    // Next merges Set-Cookie back into the render request. Deleting only request
    // cookies is insufficient if an earlier refresh still writes a live session.
    expect(res.set.filter((write) => write.name.startsWith(KEY) && write.value)).toEqual([]);
    expect(res.set.find((write) => write.name === KEY)?.options?.maxAge).toBe(0);
  });

  it('does not write an unverified refresh back after a subsequent getUser outage', async () => {
    const fresh = now() + 3600;
    authApi({
      refresh: () => json(200, {
        access_token: jwt(fresh), refresh_token: 'refresh-2', token_type: 'bearer',
        expires_in: 3600, expires_at: fresh, user,
      }),
      user: () => json(503, { message: 'Auth unavailable' }),
    });
    const req = request({ [KEY]: sessionCookie(now() - 60) });
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session).toBeNull();
    expect(req.jar.has(KEY)).toBe(false);
    expect(auth.apply(response()).set).toEqual([]);
  });

  it('cannot tell on an outage: preserves browser session but never forwards unverified render identity', async () => {
    authApi({
      refresh: () => {
        throw new TypeError('fetch failed');
      },
    });
    const cookie = sessionCookie(now() - 60);
    const req = request({ [KEY]: cookie });
    // auth-js retries a network failure with backoff for up to 30 s
    vi.useFakeTimers();
    const pending = refreshSupabaseSession(req, URL_, 'key');
    await vi.advanceTimersByTimeAsync(31_000);
    const auth = await pending;
    vi.useRealTimers();
    expect(auth.session).toBeNull();
    expect(req.jar.has(KEY)).toBe(false);
    expect(auth.apply(response()).set).toEqual([]);
  });

  it('is signed out without a session cookie, without calling Supabase', async () => {
    const fetchMock = authApi({});
    const auth = await refreshSupabaseSession(request({}), URL_, 'key');
    expect(auth.session).toEqual({ user: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Asymmetric (ES256) project key: a signed access token and the JWKS that verifies it. */
async function es256Project(kid: string) {
  const { privateKey, publicKey } = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify']
  );
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const part = (o: object) => stringToBase64URL(JSON.stringify(o));
  const sign = async (claims: Record<string, unknown>) => {
    const input = `${part({ alg: 'ES256', typ: 'JWT', kid })}.${part(claims)}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        privateKey,
        new TextEncoder().encode(input)
      )
    );
    const b64 = btoa(String.fromCharCode(...signature))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${input}.${b64}`;
  };
  const jwks = { keys: [{ ...jwk, kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] }] };
  return { sign, jwks };
}

/** Session cookie carrying a given access token (and cookie user). */
function sessionCookieWith(accessToken: string, expiresAt: number, cookieUser: object = user) {
  return `base64-${stringToBase64URL(
    JSON.stringify({
      access_token: accessToken,
      refresh_token: 'refresh-1',
      token_type: 'bearer',
      expires_in: 3600,
      expires_at: expiresAt,
      user: cookieUser,
    })
  )}`;
}

/** Claims Supabase Auth signs into an access token for `user`. */
const claimsOf = (exp: number) => ({
  sub: 'u1',
  aud: 'authenticated',
  role: 'authenticated',
  exp,
  iat: exp - 3600,
  iss: `${URL_}/auth/v1`,
  session_id: 's1',
  aal: 'aal1',
  email: 'pro@example.com',
  is_anonymous: false,
  app_metadata: { role: 'user' },
  user_metadata: {},
});

describe('refreshSupabaseSession on client-router fetches (getClaims)', () => {
  it('verifies an ES256 token locally: signed in, no Auth user call, identity from the claims', async () => {
    const project = await es256Project('kid-local');
    const expires = now() + 3600;
    const token = await project.sign(claimsOf(expires));
    const fetchMock = authApi({ jwks: () => json(200, project.jwks) });
    // Cookie user tampered (role, metadata): never forwarded, the signed claims are
    const tampered = { ...user, app_metadata: { role: 'super' } };
    const req = request({ [KEY]: sessionCookieWith(token, expires, tampered) }, ROUTER_FETCH);
    const auth = await refreshSupabaseSession(req, URL_, 'key');

    expect(auth.session?.user).toMatchObject({ id: 'u1', role: 'user', email: 'pro@example.com' });
    expect(auth.session?.accessToken).toBe(token);
    const forwarded = req.cookies.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
    expect(readSupabaseSessionCookie(forwarded)?.user).toEqual(auth.session?.user);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/v1/user'))).toBe(false);
    expect(auth.apply(response()).set).toEqual([]);
  });

  it('ignores forged cookie user fields, same user or not: the forwarded user is the claims', async () => {
    const project = await es256Project('kid-forged-cookie');
    const expires = now() + 3600;
    const token = await project.sign(claimsOf(expires));
    authApi({ jwks: () => json(200, project.jwks) });
    for (const forged of [
      { ...user, id: 'victim', email: 'victim@example.com' },
      // Same user forging non-claim fields: never forwarded
      { ...user, email_confirmed_at: '2026-11-01T00:00:00Z', user_metadata: { full_name: 'Forged' }, app_metadata: { role: 'super' } },
    ]) {
      const req = request({ [KEY]: sessionCookieWith(token, expires, forged) }, ROUTER_FETCH);
      const auth = await refreshSupabaseSession(req, URL_, 'key');
      expect(auth.session?.user).toMatchObject({ id: 'u1', email: 'pro@example.com', role: 'user', emailVerified: false });
      expect(auth.session?.user?.displayName).toBeUndefined();
      const forwarded = req.cookies.getAll().map(({ name, value }) => `${name}=${encodeURIComponent(value)}`).join('; ');
      expect(readSupabaseSessionCookie(forwarded)?.user).toEqual(auth.session?.user);
      // No refresh: the claims-only user stays in the render request, never the browser
      expect(auth.apply(response()).set.filter((write) => write.name.startsWith(KEY))).toEqual([]);
    }
  });

  it('refreshes an expired token: render and response cookies carry the user Auth returned', async () => {
    const project = await es256Project('kid-refresh');
    const fresh = now() + 3600;
    const freshToken = await project.sign(claimsOf(fresh));
    const staleToken = await project.sign(claimsOf(now() - 60));
    // Full user record from Auth's /token response in this request
    const refreshedUser = {
      ...user,
      identities: [{ provider: 'email', identity_id: 'i1' }],
    };
    const fetchMock = authApi({
      refresh: () => json(200, {
        access_token: freshToken, refresh_token: 'refresh-2', token_type: 'bearer',
        expires_in: 3600, expires_at: fresh, user: refreshedUser,
      }),
      jwks: () => json(200, project.jwks),
    });
    // Incoming cookie user forged: replaced by the refreshed one
    const forged = { ...user, app_metadata: { role: 'super' } };
    const req = request({ [KEY]: sessionCookieWith(staleToken, now() - 60, forged) }, ROUTER_FETCH);
    const auth = await refreshSupabaseSession(req, URL_, 'key');

    expect(auth.session?.user).toMatchObject({ id: 'u1', role: 'user', emailVerified: true });
    expect(auth.session?.accessToken).toBe(freshToken);
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/auth/v1/token'))).toBe(true);
    expect(urls.some((u) => u.includes('/auth/v1/user'))).toBe(false);
    const written = writtenSession(auth.apply(response()).set);
    expect(written.refresh_token).toBe('refresh-2');
    expect(written.access_token).toBe(freshToken);
    expect(written.user).toEqual(refreshedUser);
    expect(written.user.email_confirmed_at).toBe('2026-11-01T00:00:00Z');
  });

  it('fails loud when the refreshed session user is not the verified token subject', async () => {
    const project = await es256Project('kid-refresh-mismatch');
    const fresh = now() + 3600;
    const freshToken = await project.sign(claimsOf(fresh));
    authApi({
      refresh: () => json(200, {
        access_token: freshToken, refresh_token: 'refresh-2', token_type: 'bearer',
        expires_in: 3600, expires_at: fresh, user: { ...user, id: 'someone-else' },
      }),
      jwks: () => json(200, project.jwks),
    });
    const req = request({ [KEY]: sessionCookieWith(await project.sign(claimsOf(now() - 60)), now() - 60) }, ROUTER_FETCH);
    await expect(refreshSupabaseSession(req, URL_, 'key')).rejects.toThrow(
      'Refreshed Supabase session user does not match the verified token'
    );
  });

  it('signs out a token whose signature does not verify', async () => {
    const project = await es256Project('kid-forged');
    const forger = await es256Project('kid-forged');
    const expires = now() + 3600;
    const token = await forger.sign(claimsOf(expires));
    authApi({ jwks: () => json(200, project.jwks) });
    const req = request({ [KEY]: sessionCookieWith(token, expires) }, ROUTER_FETCH);
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session).toEqual({ user: null });
    expect(req.jar.has(KEY)).toBe(false);
  });

  it('cannot tell when the JWKS is unreachable: no unverified identity forwarded', async () => {
    const project = await es256Project('kid-outage');
    const expires = now() + 3600;
    const token = await project.sign(claimsOf(expires));
    authApi({ jwks: () => json(503, { message: 'unavailable' }) });
    const req = request({ [KEY]: sessionCookieWith(token, expires) }, ROUTER_FETCH);
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session).toBeNull();
    expect(req.jar.has(KEY)).toBe(false);
    expect(auth.apply(response()).set).toEqual([]);
  });

  it('legacy HS256 project: getClaims verifies with Auth, same verdict', async () => {
    const fetchMock = authApi({ user: () => json(200, user) });
    const req = request({ [KEY]: sessionCookie(now() + 3600) }, ROUTER_FETCH);
    const auth = await refreshSupabaseSession(req, URL_, 'key');
    expect(auth.session?.user?.id).toBe('u1');
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/auth/v1/user'))).toBe(true);
  });

  it('documents, Server Actions (any POST) and requests without Fetch Metadata keep getUser', async () => {
    const project = await es256Project('kid-documents');
    const expires = now() + 3600;
    const token = await project.sign(claimsOf(expires));
    const cases: Array<[Record<string, string>, string]> = [
      [DOCUMENT, 'GET'],
      [{}, 'GET'],
      [{ ...ROUTER_FETCH, 'next-action': 'a1' }, 'POST'],
      // Multipart form POST without Next-Action: Next treats it as a Server Action
      [{ ...ROUTER_FETCH, 'content-type': 'multipart/form-data; boundary=x' }, 'POST'],
      [{ ...ROUTER_FETCH, 'content-type': 'application/x-www-form-urlencoded' }, 'POST'],
    ];
    for (const [headers, method] of cases) {
      const fetchMock = authApi({ user: () => json(200, user), jwks: () => json(200, project.jwks) });
      const req = request({ [KEY]: sessionCookieWith(token, expires) }, headers, method);
      const auth = await refreshSupabaseSession(req, URL_, 'key');
      expect(auth.session?.user?.id).toBe('u1');
      const urls = fetchMock.mock.calls.map(([u]) => String(u));
      expect(urls.some((u) => u.includes('/auth/v1/user'))).toBe(true);
      expect(urls.some((u) => u.includes('jwks.json'))).toBe(false);
    }
  });
});
