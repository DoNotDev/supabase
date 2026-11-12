// packages/providers/supabase/src/__tests__/rememberMe.test.ts

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '@supabase/supabase-js';

type CookieWrite = {
  name: string;
  value: string;
  options: { maxAge?: number; expires?: Date; path?: string };
};
type CookieMethods = {
  getAll: () => Array<{ name: string; value: string }>;
  setAll: (cookies: CookieWrite[]) => void;
};

const captured: { cookies?: CookieMethods } = {};
vi.mock('@supabase/ssr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@supabase/ssr')>();
  return {
    ...actual,
    createBrowserClient: vi.fn(
      (_url: string, _key: string, options: { cookies: CookieMethods }) => {
        captured.cookies = options.cookies;
        return { auth: {} };
      }
    ),
  };
});

import { SupabaseAuth } from '../client/auth';
import { createBrowserClient } from '../client/browserClient';

/** document.cookie writes, as raw `Set-Cookie`-like strings. */
function recordCookieWrites(): string[] {
  const writes: string[] = [];
  const jar = new Map<string, string>();
  vi.spyOn(document, 'cookie', 'set').mockImplementation((raw: string) => {
    writes.push(raw);
    const [pair] = raw.split(';');
    const [name, value] = pair!.split('=');
    if (/max-age=0/i.test(raw)) jar.delete(name!);
    else jar.set(name!, value ?? '');
  });
  vi.spyOn(document, 'cookie', 'get').mockImplementation(() =>
    [...jar].map(([n, v]) => `${n}=${v}`).join('; ')
  );
  return writes;
}

const tokenWrite: CookieWrite = {
  name: 'sb-ref-auth-token',
  value: 'base64-abc',
  options: { path: '/', maxAge: 400 * 24 * 3600 },
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Supabase remember me (cookie client)', () => {
  it('keeps the persistent cookie by default', () => {
    const writes = recordCookieWrites();
    createBrowserClient('https://ref.supabase.co', 'key');
    captured.cookies!.setAll([tokenWrite]);
    expect(writes.at(-1)).toMatch(/Max-Age=34560000/);
  });

  it('writes session cookies, token refreshes included, after "do not remember me"', async () => {
    const writes = recordCookieWrites();
    const auth = new SupabaseAuth(
      createBrowserClient('https://ref.supabase.co', 'key')
    );
    expect(auth.supportsRememberMe()).toBe(true);
    await auth.setRememberMe(false);
    captured.cookies!.setAll([tokenWrite]);
    captured.cookies!.setAll([{ ...tokenWrite, value: 'base64-refreshed' }]);
    const tokenWrites = writes.filter((w) => w.startsWith('sb-ref-auth-token='));
    expect(tokenWrites).toHaveLength(2);
    for (const write of tokenWrites) {
      expect(write).not.toMatch(/Max-Age|Expires/i);
    }
  });

  it('still removes cookies (Max-Age=0) when session-only', async () => {
    const writes = recordCookieWrites();
    const auth = new SupabaseAuth(
      createBrowserClient('https://ref.supabase.co', 'key')
    );
    await auth.setRememberMe(false);
    captured.cookies!.setAll([
      { ...tokenWrite, value: '', options: { path: '/', maxAge: 0 } },
    ]);
    expect(writes.at(-1)).toMatch(/Max-Age=0/);
  });

  it('goes back to persistent cookies after "remember me"', async () => {
    const writes = recordCookieWrites();
    const auth = new SupabaseAuth(
      createBrowserClient('https://ref.supabase.co', 'key')
    );
    await auth.setRememberMe(false);
    await auth.setRememberMe(true);
    captured.cookies!.setAll([tokenWrite]);
    expect(writes.at(-1)).toMatch(/Max-Age=34560000/);
  });

  it('fails loud on a localStorage client', async () => {
    const auth = new SupabaseAuth(createClient('https://ref.supabase.co', 'key'));
    expect(auth.supportsRememberMe()).toBe(false);
    await expect(auth.setRememberMe(false)).rejects.toThrow(/cookie client/);
  });
});
