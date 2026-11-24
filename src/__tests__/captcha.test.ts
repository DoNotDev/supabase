// packages/providers/supabase/src/__tests__/captcha.test.ts

/**
 * @fileoverview CAPTCHA tokens on the gated Supabase Auth calls
 * @description Each call Supabase Auth gates with CAPTCHA protection (sign-up, password
 * sign-in and re-authentication, OTP / magic link, resend, password-reset request) sends
 * a fresh token from `getCaptchaToken`; without a site key (token `undefined`) no
 * `captchaToken` is sent; a token failure rejects with `captcha_failed` kept. Not gated:
 * `verifyOtp`. Mocked client, no network.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SupabaseAuth } from '../client/auth';

const getCaptchaToken = vi.fn<() => Promise<string | undefined>>();

vi.mock('@donotdev/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@donotdev/core')>();
  return { ...actual, getCaptchaToken: () => getCaptchaToken() };
});

const user = {
  id: 'u1',
  email: 'a@b.co',
  identities: [{ id: 'i1' }],
  user_metadata: {},
  app_metadata: {},
};

function createClient() {
  const auth = {
    getUser: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    signInWithPassword: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    signUp: vi.fn().mockResolvedValue({ data: { user }, error: null }),
    resetPasswordForEmail: vi.fn().mockResolvedValue({ error: null }),
    resend: vi.fn().mockResolvedValue({ error: null }),
    signInWithOtp: vi.fn().mockResolvedValue({ error: null }),
    verifyOtp: vi.fn().mockResolvedValue({ data: { user }, error: null }),
  };
  return {
    auth,
    provider: new SupabaseAuth(
      { auth } as unknown as import('@supabase/supabase-js').SupabaseClient
    ),
  };
}

let tokens = 0;

beforeEach(() => {
  vi.clearAllMocks();
  tokens = 0;
  getCaptchaToken.mockImplementation(async () => `token-${++tokens}`);
});

describe('site key set: every gated call sends its own token', () => {
  it('password sign-in', async () => {
    const { auth, provider } = createClient();
    await provider.signInWithEmail('a@b.co', 'pw');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'pw',
      options: { captchaToken: 'token-1' },
    });
  });

  it('sign-up, with the metadata kept', async () => {
    const { auth, provider } = createClient();
    await provider.createUserWithEmail('a@b.co', 'pw', { full_name: 'A' });
    expect(auth.signUp).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'pw',
      options: { data: { full_name: 'A' }, captchaToken: 'token-1' },
    });
  });

  it('password-reset request', async () => {
    const { auth, provider } = createClient();
    await provider.sendPasswordResetEmail('a@b.co');
    expect(auth.resetPasswordForEmail).toHaveBeenCalledWith('a@b.co', {
      redirectTo: window.location.origin,
      captchaToken: 'token-1',
    });
  });

  it('resend of the confirmation code', async () => {
    const { auth, provider } = createClient();
    await provider.sendEmailVerification('a@b.co');
    expect(auth.resend).toHaveBeenCalledWith({
      type: 'signup',
      email: 'a@b.co',
      options: { captchaToken: 'token-1' },
    });
  });

  it('magic link / OTP sign-in', async () => {
    const { auth, provider } = createClient();
    await provider.sendSignInLinkToEmail('a@b.co', {
      url: 'https://app.test/in',
      handleCodeInApp: true,
    });
    expect(auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      options: { emailRedirectTo: 'https://app.test/in', captchaToken: 'token-1' },
    });
  });

  it('re-authentication with the password', async () => {
    const { auth, provider } = createClient();
    await provider.reauthenticateWithPassword('pw');
    expect(auth.signInWithPassword).toHaveBeenCalledWith({
      email: 'a@b.co',
      password: 'pw',
      options: { captchaToken: 'token-1' },
    });
  });

  it('a fresh token per call (single-use)', async () => {
    const { auth, provider } = createClient();
    await provider.signInWithEmail('a@b.co', 'pw');
    await provider.signInWithEmail('a@b.co', 'pw');
    expect(getCaptchaToken).toHaveBeenCalledTimes(2);
    expect(auth.signInWithPassword.mock.calls.map((c) => c[0].options)).toEqual([
      { captchaToken: 'token-1' },
      { captchaToken: 'token-2' },
    ]);
  });

  it('code confirmation (verifyOtp) is not gated: no token taken', async () => {
    const { auth, provider } = createClient();
    await provider.verifyEmailCode('a@b.co', '123456');
    expect(getCaptchaToken).not.toHaveBeenCalled();
    expect(auth.verifyOtp).toHaveBeenCalledWith({
      email: 'a@b.co',
      token: '123456',
      type: 'signup',
    });
  });

  it('a token failure rejects with captcha_failed, the call never goes out', async () => {
    const { auth, provider } = createClient();
    getCaptchaToken.mockRejectedValueOnce(
      Object.assign(new Error('captcha verification failed: widget error 300010'), {
        code: 'captcha_failed',
      })
    );
    await expect(provider.signInWithEmail('a@b.co', 'pw')).rejects.toMatchObject({
      details: { originalCode: 'captcha_failed' },
    });
    expect(auth.signInWithPassword).not.toHaveBeenCalled();
  });
});

describe('no site key: no captchaToken is sent', () => {
  beforeEach(() => {
    getCaptchaToken.mockResolvedValue(undefined);
  });

  it('sign-in, sign-up, reset, resend, OTP', async () => {
    const { auth, provider } = createClient();
    await provider.signInWithEmail('a@b.co', 'pw');
    await provider.createUserWithEmail('a@b.co', 'pw');
    await provider.sendPasswordResetEmail('a@b.co');
    await provider.sendEmailVerification('a@b.co');
    await provider.sendSignInLinkToEmail('a@b.co', {
      url: 'https://app.test/in',
      handleCodeInApp: true,
    });
    expect(auth.signInWithPassword.mock.calls[0][0].options).toEqual({});
    expect(auth.signUp.mock.calls[0][0].options).toEqual({});
    expect(auth.resetPasswordForEmail.mock.calls[0][1]).toEqual({
      redirectTo: window.location.origin,
    });
    expect(auth.resend.mock.calls[0][0].options).toEqual({});
    expect(auth.signInWithOtp.mock.calls[0][0].options).toEqual({
      emailRedirectTo: 'https://app.test/in',
    });
  });
});
