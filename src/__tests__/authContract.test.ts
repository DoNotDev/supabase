// packages/providers/supabase/src/__tests__/authContract.test.ts

/**
 * @fileoverview Contract tests for Supabase Auth (AuthProvider)
 * @description Verifies SupabaseAuth satisfies AuthProvider with a mocked Supabase client.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { configureProviders, resetProviders } from '@donotdev/core';
import type { AuthProvider, SecurityContext } from '@donotdev/core';

import { SupabaseAuth } from '../client/auth';

// =============================================================================
// Mock Supabase client (auth only)
// =============================================================================

function createMockSupabaseClient(overrides?: {
  user?: {
    id: string;
    email?: string;
    user_metadata?: Record<string, unknown>;
    app_metadata?: Record<string, unknown>;
    email_confirmed_at?: string;
  } | null;
  session?: { access_token: string } | null;
}) {
  const user = overrides?.user ?? null;
  const session = overrides?.session ?? null;

  const onAuthStateChange = vi.fn().mockReturnValue({
    data: {
      subscription: { unsubscribe: vi.fn() },
    },
  });

  const mockAuth = {
    getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    signInWithPassword: vi.fn().mockRejectedValue(new Error('mock signIn')),
    signUp: vi.fn().mockRejectedValue(new Error('mock signUp')),
    signOut: vi.fn().mockResolvedValue({ error: null }),
    resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    updateUser: vi.fn().mockResolvedValue({ error: null }),
    refreshSession: vi
      .fn()
      .mockResolvedValue({ data: { session }, error: null }),
    onAuthStateChange,
    signInWithOAuth: vi
      .fn()
      .mockResolvedValue({ data: { url: null }, error: null }),
    linkIdentity: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    resend: vi.fn().mockResolvedValue(undefined),
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
  };

  return {
    auth: mockAuth,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('SupabaseAuth — AuthProvider contract', () => {
  let client: ReturnType<typeof createMockSupabaseClient>;
  let provider: SupabaseAuth;

  beforeEach(() => {
    client = createMockSupabaseClient();
    provider = new SupabaseAuth(client);
  });

  it('satisfies AuthProvider type', () => {
    const typed: AuthProvider = provider;
    expect(typed).toBeDefined();
  });

  it('initialize() resolves without throwing', async () => {
    await expect(provider.initialize()).resolves.toBeUndefined();
    expect(client.auth.getSession).toHaveBeenCalled();
  });

  it('getCurrentUser() returns null when no user', async () => {
    const user = await provider.getCurrentUser();
    expect(user).toBeNull();
  });

  it('getCurrentUser() returns AuthUser when mock has user', async () => {
    const mockUser = {
      id: 'uid-123',
      email: 'test@example.com',
      user_metadata: { full_name: 'Test' },
      app_metadata: {},
      email_confirmed_at: '2020-01-01T00:00:00Z',
    };
    const clientWithUser = createMockSupabaseClient({ user: mockUser });
    const providerWithUser = new SupabaseAuth(clientWithUser);
    const user = await providerWithUser.getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.id).toBe('uid-123');
    expect(user?.email).toBe('test@example.com');
    expect(user?.emailVerified).toBe(true);
  });

  it('signOut() resolves without throwing', async () => {
    await expect(provider.signOut()).resolves.toBeUndefined();
    expect(client.auth.signOut).toHaveBeenCalled();
  });

  it('onAuthStateChanged() returns an unsubscribe function', () => {
    const unsub = provider.onAuthStateChanged(vi.fn());
    expect(typeof unsub).toBe('function');
    unsub();
    expect(client.auth.onAuthStateChange).toHaveBeenCalled();
  });

  it('deleteAccount() throws with code DELETE_ACCOUNT_REQUIRES_SERVER', async () => {
    await expect(provider.deleteAccount()).rejects.toMatchObject({
      message: expect.stringContaining('Edge Function'),
      code: 'DELETE_ACCOUNT_REQUIRES_SERVER',
    });
  });

  it('listUsers() throws with code LIST_USERS_REQUIRES_SERVER without a callable provider', async () => {
    resetProviders();
    await expect(provider.listUsers()).rejects.toMatchObject({
      message: expect.stringContaining('list-auth-users'),
      details: { originalCode: 'LIST_USERS_REQUIRES_SERVER' },
    });
  });

  it('listUsers() calls the list-auth-users function and returns its users', async () => {
    const users = [
      {
        id: 'u1',
        email: 'a@example.com',
        emailConfirmedAt: null,
        createdAt: '2026-01-01T00:00:00Z',
        lastSignInAt: null,
        displayName: null,
      },
    ];
    const call = vi.fn().mockResolvedValue({ users });
    configureProviders({ callable: { call } } as never);
    try {
      await expect(provider.listUsers()).resolves.toEqual(users);
      expect(call).toHaveBeenCalledWith('list-auth-users', {});
    } finally {
      resetProviders();
    }
  });

  it('has required AuthProvider methods', () => {
    expect(typeof provider.initialize).toBe('function');
    expect(typeof provider.getCurrentUser).toBe('function');
    expect(typeof provider.signInWithEmailAndPassword).toBe('function');
    expect(typeof provider.createUserWithEmailAndPassword).toBe('function');
    expect(typeof provider.signOut).toBe('function');
    expect(typeof provider.signInWithPartner).toBe('function');
    expect(typeof provider.linkWithPartner).toBe('function');
    expect(typeof provider.reauthenticateWithProvider).toBe('function');
    expect(typeof provider.updatePassword).toBe('function');
    expect(typeof provider.hasRole).toBe('function');
    expect(typeof provider.hasFeature).toBe('function');
    expect(typeof provider.hasTier).toBe('function');
  });

  it('hasRole() returns false when no user', async () => {
    expect(await provider.hasRole('admin')).toBe(false);
  });

  it('hasRole() returns boolean when user has role in hierarchy', async () => {
    const clientWithUser = createMockSupabaseClient({
      user: {
        id: 'u1',
        email: 'a@b.com',
        app_metadata: { role: 'admin' },
        user_metadata: {},
        email_confirmed_at: undefined,
      },
    });
    const p = new SupabaseAuth(clientWithUser);
    const result = await p.hasRole('admin');
    expect(typeof result).toBe('boolean');
  });

  it('hasFeature() returns false when no user', async () => {
    expect(await provider.hasFeature('export')).toBe(false);
  });

  it('hasTier() returns false when no user', async () => {
    expect(await provider.hasTier('pro')).toBe(false);
  });

  it('getAccessToken() returns null when no session', async () => {
    const token = await provider.getAccessToken();
    expect(token).toBeNull();
  });

  it('getAccessToken() returns string when mock has session', async () => {
    const clientWithSession = createMockSupabaseClient({
      session: { access_token: 'mock-token' },
    });
    const p = new SupabaseAuth(clientWithSession);
    const token = await p.getAccessToken();
    expect(token).toBe('mock-token');
  });

  it('signInWithEmailAndPassword() throws when mock rejects', async () => {
    await expect(
      provider.signInWithEmailAndPassword('a@b.com', 'pass')
    ).rejects.toThrow();
  });

  it('sendPasswordResetEmail() resolves without throwing', async () => {
    await expect(
      provider.sendPasswordResetEmail('reset@example.com')
    ).resolves.toBeUndefined();
  });

  it('verifyEmailCode() verifies the sign-up code and returns the mapped user', async () => {
    const auth = (client as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth;
    auth.verifyOtp!.mockResolvedValue({
      data: {
        user: {
          id: 'u1',
          email: 'new@example.com',
          email_confirmed_at: '2026-11-22T00:00:00Z',
          user_metadata: {},
          app_metadata: {},
        },
        session: { access_token: 't' },
      },
      error: null,
    });
    const user = await provider.verifyEmailCode('new@example.com', '12345678');
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'new@example.com',
      token: '12345678',
      type: 'signup',
    });
    expect(user.id).toBe('u1');
    expect(user.email).toBe('new@example.com');
  });

  it('verifyEmailCode() keeps the GoTrue code of a wrong code in details.originalCode', async () => {
    const auth = (client as unknown as { auth: Record<string, ReturnType<typeof vi.fn>> }).auth;
    auth.verifyOtp!.mockResolvedValue({
      data: { user: null, session: null },
      error: Object.assign(new Error('Token has expired or is invalid'), {
        code: 'otp_expired',
        status: 403,
      }),
    });
    await expect(
      provider.verifyEmailCode('new@example.com', '00000000')
    ).rejects.toMatchObject({ details: { originalCode: 'otp_expired' } });
  });
});

describe('SupabaseAuth — lockout audit', () => {
  // Regression: recordFailure's result drives the 'auth.locked' audit event.
  it('audits auth.locked with the attempt count when a failure locks the account', async () => {
    const client = createMockSupabaseClient();
    const provider = new SupabaseAuth(client);
    const audit = vi.fn();
    provider.setSecurity({
      audit,
      authHardening: {
        checkLockout: vi.fn(),
        recordFailure: vi.fn().mockReturnValue({ locked: true, attempts: 5 }),
        recordSuccess: vi.fn(),
      },
    } as unknown as SecurityContext);
    vi.mocked(client.auth.signInWithPassword).mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new Error('invalid'),
    } as never);

    await expect(
      provider.signInWithEmailAndPassword('a@example.com', 'bad')
    ).rejects.toThrow();

    expect(audit).toHaveBeenCalledWith({
      type: 'auth.locked',
      metadata: { attempts: 5 },
    });
    expect(audit).toHaveBeenCalledWith({ type: 'auth.login.failure' });
  });
});
