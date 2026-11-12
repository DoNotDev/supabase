import { describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

vi.mock('@supabase/ssr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/ssr')>();
  return { ...actual, createBrowserClient: vi.fn(() => ({ auth: {} })) };
});

import { stringToBase64URL } from '@supabase/ssr';

import { SupabaseAuth } from '../client/auth';
import { createBrowserClient } from '../client/browserClient';

const KEY = 'sb-abcdref-auth-token';
const session = {
  access_token: 'token',
  refresh_token: 'refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: 'u1',
    email: 'pro@example.com',
    email_confirmed_at: '2026-11-01T00:00:00Z',
    user_metadata: { full_name: 'Pro Institut' },
    app_metadata: { role: 'user' },
  },
};
const encoded = `base64-${stringToBase64URL(JSON.stringify(session))}`;

function cookieAuth() {
  return new SupabaseAuth(createBrowserClient('https://abcdref.supabase.co', 'key'));
}

describe('SupabaseAuth.readSessionSnapshot', () => {
  it('reads the signed-in user from a whole session cookie', () => {
    const snapshot = cookieAuth().readSessionSnapshot(
      `dndev-lang=fr; ${KEY}=${encodeURIComponent(encoded)}`
    );
    expect(snapshot?.user).toMatchObject({
      id: 'u1',
      email: 'pro@example.com',
      displayName: 'Pro Institut',
      emailVerified: true,
      role: 'user',
    });
  });

  it('joins chunked cookies (.0, .1) as @supabase/ssr writes them', () => {
    const mid = Math.floor(encoded.length / 2);
    const header = `${KEY}.1=${encoded.slice(mid)}; ${KEY}.0=${encoded.slice(0, mid)}`;
    expect(cookieAuth().readSessionSnapshot(header)?.user?.id).toBe('u1');
  });

  it('reads plain JSON values too', () => {
    const header = `${KEY}=${encodeURIComponent(JSON.stringify(session))}`;
    expect(cookieAuth().readSessionSnapshot(header)?.user?.id).toBe('u1');
  });

  it('is signed out when there is no session cookie', () => {
    expect(cookieAuth().readSessionSnapshot('dndev-lang=fr')).toEqual({ user: null });
    expect(
      cookieAuth().readSessionSnapshot(`${KEY}-code-verifier=abc`)
    ).toEqual({ user: null });
  });

  it('cannot tell with several projects or an unreadable cookie', () => {
    expect(
      cookieAuth().readSessionSnapshot(`${KEY}=${encoded}; sb-other-auth-token=${encoded}`)
    ).toBeNull();
    expect(cookieAuth().readSessionSnapshot(`${KEY}=base64-%%%`)).toBeNull();
  });

  it('cannot tell for a localStorage client (createClient)', () => {
    const auth = new SupabaseAuth({ auth: {} } as unknown as SupabaseClient);
    expect(auth.readSessionSnapshot(`${KEY}=${encoded}`)).toBeNull();
  });
});

describe('SupabaseAuth.readSessionSnapshot access token', () => {
  const withExpiry = (expiresAt: number) =>
    `${KEY}=${encodeURIComponent(`base64-${stringToBase64URL(JSON.stringify({ ...session, expires_at: expiresAt }))}`)}`;

  it('exposes the access token while it stays valid for the render', () => {
    const inAnHour = Math.floor(Date.now() / 1000) + 3600;
    expect(cookieAuth().readSessionSnapshot(withExpiry(inAnHour))?.accessToken).toBe('token');
  });

  it('drops a nearly expired token, keeping the user (still signed in)', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(cookieAuth().readSessionSnapshot(withExpiry(now + 30))?.accessToken).toBeUndefined();
    expect(cookieAuth().readSessionSnapshot(withExpiry(now + 30))?.user?.id).toBe('u1');
  });

  /**
   * Regression: an expired session counted as signed in (proxy signedInRedirect sent a
   * visitor whose refresh token was dead to /catalogue; useAuth reported the user).
   */
  it('cannot tell once the access token has expired: only a refresh knows', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(cookieAuth().readSessionSnapshot(withExpiry(now - 10))).toBeNull();
    expect(cookieAuth().readSessionSnapshot(withExpiry(now))).toBeNull();
  });

  it('cannot tell without an expiry', () => {
    const { expires_at: _expiresAt, ...undated } = session;
    expect(
      cookieAuth().readSessionSnapshot(`${KEY}=${encodeURIComponent(JSON.stringify(undated))}`)
    ).toBeNull();
  });
});
