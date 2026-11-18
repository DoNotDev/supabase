import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthActions, AuthState } from '@donotdev/core';
import { resolveUserSubscription } from '@donotdev/core';

import { SupabaseAuth } from '../client/auth';
import { mapSupabaseUserToAuthUser, readSupabaseSessionCookie } from '../common/sessionCookie';
import { SupabaseServerAuthAdapter } from '../server/authAdapter';

const generic = {
  tier: 'pro', status: 'active', subscriptionEnd: null,
  updatedAt: '2026-11-01T00:00:00.000Z', features: ['export'],
};
const paid = {
  ...generic, subscriptionId: 'sub_1', customerId: 'cus_1', cancelAtPeriodEnd: true,
};
const editable = { role: 'super', isAdmin: true, tier: 'ai', subscription: paid, features: ['admin'], full_name: 'Profile name' };
function user(subscription?: unknown) {
  return { id: 'u1', user_metadata: editable, app_metadata: subscription === undefined ? {} : { subscription, features: ['paid-export'] } };
}
function harness(subscription?: unknown) {
  const current = user(subscription);
  const auth = {
    getSession: vi.fn().mockResolvedValue({ data: { session: { user: current } } }),
    getUser: vi.fn().mockResolvedValue({ data: { user: current } }),
    refreshSession: vi.fn(),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
    admin: { getUserById: vi.fn().mockResolvedValue({ data: { user: current } }), updateUserById: vi.fn().mockResolvedValue({ error: null }) },
  };
  const client = { auth } as unknown as SupabaseClient;
  const store = { setAuthenticated: vi.fn(), setUnauthenticated: vi.fn() };
  const provider = new SupabaseAuth(client);
  provider.setStore(store as unknown as AuthState & AuthActions);
  return { auth, client, store, provider };
}

describe('Supabase canonical subscription and metadata trust', () => {
  it('keeps editable metadata as profile data, never authorization claims', async () => {
    const mapped = mapSupabaseUserToAuthUser(user());
    expect(mapped).toMatchObject({ role: 'user', displayName: 'Profile name', customClaims: {} });
    const { provider, client } = harness();
    expect(await provider.hasRole('admin')).toBe(false);
    expect(await provider.hasTier('pro')).toBe(false);
    expect(await provider.hasFeature('admin')).toBe(false);
    const server = new SupabaseServerAuthAdapter(client);
    expect((await server.verifyToken('token')).claims).toEqual({});
    expect(await server.getUser('u1')).toMatchObject({ displayName: 'Profile name', customClaims: {} });
  });

  it.each([generic, paid])('uses the same canonical projection in browser and cookie snapshot: %j', async (claims) => {
    const { provider, store } = harness(claims);
    await provider.initialize();
    const expected = resolveUserSubscription('u1', claims);
    expect(store.setAuthenticated.mock.calls[0]?.[1]).toEqual(expected);
    const snapshot = readSupabaseSessionCookie(`sb-ref-auth-token=${encodeURIComponent(JSON.stringify({ user: user(claims), access_token: 'token', expires_at: Date.now() / 1000 + 3600 }))}`);
    expect(snapshot?.userSubscription).toEqual(expected);
    expect(await provider.hasTier('free')).toBe(true);
    expect(await provider.hasTier('pro')).toBe(true);
    expect(await provider.hasTier('ai')).toBe(false);
    expect(await provider.hasFeature('paid-export')).toBe(true);
    expect(await provider.hasFeature('export')).toBe(false);
    expect(await provider.hasFeature('admin')).toBe(false);
  });

  it('applies a complete grant then revoke before refreshToken resolves', async () => {
    const { provider, auth, store } = harness();
    for (const claims of [paid, { ...generic, tier: 'free', status: 'canceled', features: [] }, undefined]) {
      const session = { access_token: 'fresh', user: user(claims) };
      auth.refreshSession.mockResolvedValueOnce({ data: { session } });
      auth.getSession.mockResolvedValueOnce({ data: { session } });
      expect(await provider.refreshToken()).toBe('fresh');
      expect(store.setAuthenticated.mock.lastCall?.[1]).toEqual(resolveUserSubscription('u1', claims));
    }
  });

  it('clears stale state when refresh succeeds without a session', async () => {
    const { provider, auth, store } = harness();
    auth.refreshSession.mockResolvedValueOnce({ data: { session: null }, error: null });
    auth.getSession.mockResolvedValueOnce({ data: { session: null } });
    expect(await provider.refreshToken()).toBeNull();
    expect(store.setUnauthenticated).toHaveBeenCalled();
  });

  it('rejects malformed present subscription rather than granting free or retaining earlier access', async () => {
    const { provider, auth, store } = harness();
    const session = { access_token: 'fresh', user: user({ tier: 'pro' }) };
    auth.refreshSession.mockResolvedValueOnce({ data: { session } });
    auth.getSession.mockResolvedValueOnce({ data: { session } });
    await expect(provider.refreshToken()).rejects.toThrow();
    expect(store.setUnauthenticated).toHaveBeenCalled();
    expect(store.setAuthenticated).not.toHaveBeenCalled();
  });

  it.each(['sign-out', 'switch', 'sign-out-and-back'] as const)('discards a delayed refresh after %s', async (transition) => {
    const { provider, auth, store } = harness();
    let finish!: (value: { data: { session: { access_token: string; user: ReturnType<typeof user> } } }) => void;
    auth.refreshSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    provider.onAuthStateChanged(vi.fn());
    const refresh = provider.refreshToken();
    if (transition === 'sign-out-and-back') {
      const listener = auth.onAuthStateChange.mock.lastCall?.[0];
      listener('SIGNED_OUT', null);
      listener('SIGNED_IN', { user: user() });
      await Promise.resolve();
      store.setAuthenticated.mockClear();
    } else {
      auth.getSession.mockResolvedValueOnce({ data: { session: transition === 'switch' ? { user: { ...user(), id: 'u2' } } : null } });
    }
    finish({ data: { session: { access_token: 'stale', user: user(paid) } } });
    expect(await refresh).toBeNull();
    expect(store.setAuthenticated).not.toHaveBeenCalled();
    expect(auth.getUser).not.toHaveBeenCalled();
  });

  it('does not let delayed initialization overwrite a newer listener identity', async () => {
    const { provider, auth, store } = harness();
    let finish!: (value: { data: { session: { user: ReturnType<typeof user> } } }) => void;
    auth.getSession.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const initialization = provider.initialize();
    provider.onAuthStateChanged(vi.fn());
    auth.onAuthStateChange.mock.lastCall?.[0]('SIGNED_IN', { user: { ...user(paid), id: 'u2' } });
    finish({ data: { session: { user: user() } } });
    await initialization;
    expect(store.setAuthenticated).toHaveBeenCalledTimes(1);
    expect(store.setAuthenticated.mock.lastCall?.[0].id).toBe('u2');
  });

  it('does not let a stale malformed listener rejection clear a newer account', async () => {
    const { provider, auth, store } = harness();
    const callback = vi.fn();
    provider.onAuthStateChanged(callback);
    const listener = auth.onAuthStateChange.mock.lastCall?.[0];
    listener('SIGNED_IN', { user: user({ tier: 'pro' }) });
    listener('SIGNED_IN', { user: { ...user(paid), id: 'u2' } });
    store.setUnauthenticated.mockClear();
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(callback.mock.lastCall?.[0].id).toBe('u2');
    expect(store.setUnauthenticated).not.toHaveBeenCalled();
  });

  describe.each(['getCurrentUser', 'hasTier'] as const)('delayed %s identity lookup', (operation) => {
    it.each(['switch', 'sign-out', 'sign-out-and-back'] as const)('discards an old access grant after %s', async (transition) => {
      const { provider, auth, store } = harness();
      await provider.initialize();
      provider.onAuthStateChanged(vi.fn());
      let finish!: (value: { data: { user: ReturnType<typeof user> } }) => void;
      auth.getUser.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = operation === 'getCurrentUser' ? provider.getCurrentUser() : provider.hasTier('pro');
      const listener = auth.onAuthStateChange.mock.lastCall?.[0];
      if (transition === 'switch') listener('SIGNED_IN', { user: { ...user(), id: 'u2' } });
      else listener('SIGNED_OUT', null);
      if (transition === 'sign-out-and-back') listener('SIGNED_IN', { user: user() });
      await Promise.resolve();
      store.setAuthenticated.mockClear();
      finish({ data: { user: user(paid) } });
      expect(await pending).toBe(operation === 'getCurrentUser' ? null : false);
      expect(store.setAuthenticated).not.toHaveBeenCalled();
    });
  });

  it.each(['switch', 'sign-out'] as const)('rechecks hasTier after identity lookup resolves but before returning access on %s', async (transition) => {
    const { provider, auth } = harness();
    await provider.initialize();
    provider.onAuthStateChanged(vi.fn());
    let finish!: (value: { data: { user: ReturnType<typeof user> } }) => void;
    auth.getUser.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const pending = provider.hasTier('pro');
    finish({ data: { user: user(paid) } });
    // getCurrentUser resumes first; the identity changes before hasTier resumes.
    queueMicrotask(() => auth.onAuthStateChange.mock.lastCall?.[0](
      transition === 'switch' ? 'SIGNED_IN' : 'SIGNED_OUT',
      transition === 'switch' ? { user: { ...user(), id: 'u2' } } : null
    ));
    expect(await pending).toBe(false);
  });

  it('passes complete server subscription updates only as app_metadata without rewriting unrelated fields', async () => {
    const { client, auth } = harness();
    await new SupabaseServerAuthAdapter(client).setCustomClaims('u1', { subscription: generic });
    expect(auth.admin.updateUserById).toHaveBeenCalledWith('u1', { app_metadata: { subscription: generic } });
  });
});
