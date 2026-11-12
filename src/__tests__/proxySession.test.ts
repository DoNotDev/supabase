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

/** NextRequest['cookies'] stand-in. */
function request(cookies: Record<string, string>) {
  const jar = new Map(Object.entries(cookies));
  return {
    jar,
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

/** Stub the Auth API: `/token` (refresh) and `/user` (getUser) handlers. */
function authApi(handlers: {
  refresh?: () => Response | Promise<Response>;
  user?: () => Response | Promise<Response>;
}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/auth/v1/token') && handlers.refresh)
      return handlers.refresh();
    if (url.includes('/auth/v1/user') && handlers.user) return handlers.user();
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

  it('cannot tell when Supabase is unreachable, and leaves the cookies alone', async () => {
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
    expect(req.jar.get(KEY)).toBe(cookie);
  });

  it('is signed out without a session cookie, without calling Supabase', async () => {
    const fetchMock = authApi({});
    const auth = await refreshSupabaseSession(request({}), URL_, 'key');
    expect(auth.session).toEqual({ user: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
