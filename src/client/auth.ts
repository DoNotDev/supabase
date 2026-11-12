// packages/providers/supabase/src/client/auth.ts

/**
 * @fileoverview Supabase Auth Provider
 * @description AuthProvider implementation using Supabase Auth.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { User as SupabaseUser } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  AuthProvider,
  AuthUser,
  AuthResult,
  AuthPartnerId,
  AuthMethod,
  UnsubscribeFn,
  UserRole,
  AuthState,
  AuthActions,
  UserSubscription,
  UserProfile,
  SecurityContext,
  AuthHardeningContext,
  AuthSessionSnapshot,
} from '@donotdev/core';
import {
  isClient,
  redirectToExternalUrl,
  hasProvider,
  getProvider,
  getAuthMethod,
  createDefaultUserProfile,
  SUBSCRIPTION_TIERS,
  hasRoleAccess,
  wrapAuthError,
  DoNotDevError,
  safeSessionStorage,
} from '@donotdev/core';
import { AuthHardening } from '@donotdev/core';

import {
  mapSupabaseUserToAuthUser,
  readSupabaseSessionCookie,
} from '../common/sessionCookie';
import { hasCookieSession, setSessionOnly } from './browserClient';

// =============================================================================
// Map Supabase User to AuthUser
// =============================================================================

// Map AuthPartnerId to Supabase provider id (lowercase)
const PARTNER_TO_SUPABASE: Partial<Record<string, string>> = {
  google: 'google',
  github: 'github',
  facebook: 'facebook',
  apple: 'apple',
  discord: 'discord',
  slack: 'slack',
  microsoft: 'microsoft',
  spotify: 'spotify',
  twitch: 'twitch',
  twitter: 'twitter',
  x: 'twitter',
  linkedin: 'linkedin',
  notion: 'notion',
  medium: 'medium',
  reddit: 'reddit',
  yahoo: 'yahoo',
  youtube: 'youtube',
};

/** OAuth provider id accepted by supabase-js. */
type OAuthProvider = Parameters<
  SupabaseClient['auth']['signInWithOAuth']
>[0]['provider'];

/**
 * Supabase OAuth provider for a framework partner id (unmapped ids pass through).
 * why: supabase-js exports `Provider` as a type-only union with no runtime list to guard against;
 * an unknown id is rejected by Supabase Auth itself.
 */
function toOAuthProvider(partnerId: AuthPartnerId): OAuthProvider {
  return (PARTNER_TO_SUPABASE[partnerId] ?? partnerId) as OAuthProvider;
}

// =============================================================================
// SupabaseAuth
// =============================================================================

/**
 * Supabase Auth implementation of AuthProvider.
 *
 * @version 0.1.0
 * @since 0.0.1
 */
export class SupabaseAuth implements AuthProvider {
  private store: (AuthState & AuthActions) | null = null;
  private initialized = false;
  /** Optional security context — injected via setSecurity() */
  private security: SecurityContext | null = null;
  /**
   * Default lockout tracker — used when no SecurityContext is injected.
   * When `setSecurity()` is called, delegation is to `security.authHardening` which
   * respects the consumer's configured maxAttempts / lockoutMs.
   * Using AuthHardening (not a raw Map) ensures a single lockout implementation.
   */
  private readonly defaultHardening = new AuthHardening();

  constructor(private readonly client: SupabaseClient) {}

  /**
   * Signed-in state from the request cookies (AuthProvider.readSessionSnapshot).
   * Only for a client created by `createBrowserClient` (session in cookies): with a
   * localStorage session the cookies cannot tell, so this returns `null`.
   * Reads the `sb-<ref>-auth-token` cookie (whole or chunked `.0`, `.1`…, optionally
   * `base64-` encoded, as @supabase/ssr writes it). Display only: not verified.
   */
  readSessionSnapshot(cookieHeader: string): AuthSessionSnapshot | null {
    if (!hasCookieSession(this.client)) return null;
    return readSupabaseSessionCookie(cookieHeader);
  }

  /**
   * Set store reference for state updates
   * Called by useAuth on initialization.
   */
  setStore(store: AuthState & AuthActions): void {
    this.store = store;
  }

  /**
   * Inject a SecurityContext for audit logging + anomaly detection.
   * Call after construction: `auth.setSecurity(security)`.
   *
   * @version 0.1.0
   * @since 0.0.1
   */
  setSecurity(security: SecurityContext): void {
    this.security = security;
  }

  /**
   * Active hardening context — SecurityContext's when injected, otherwise the default instance.
   */
  private get _hardening(): AuthHardeningContext {
    return this.security?.authHardening ?? this.defaultHardening;
  }

  /**
   * Throws if email is currently locked out (SOC2 CC6.2).
   * Uses SecurityContext.authHardening when injected (respects consumer config),
   * otherwise the default AuthHardening instance with standard defaults.
   */
  private _checkLockout(email: string): void {
    try {
      this._hardening.checkLockout(email);
    } catch (err) {
      throw wrapAuthError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseAuth',
        'signInWithEmailAndPassword',
        { email }
      );
    }
  }

  private _recordFailure(email: string): void {
    const result = this._hardening.recordFailure(email);
    if (result.locked) {
      this.security?.audit({
        type: 'auth.locked',
        metadata: { attempts: result.attempts },
      });
    }
    this.security?.audit({ type: 'auth.login.failure' });
  }

  private _recordSuccess(email: string): void {
    this._hardening.recordSuccess(email);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // NOTE: getSession() reads from local storage only (no server validation).
      // For security-sensitive flows, use getUser() which validates with the server.
      // This is acceptable here: initialize() only sets initial UI state; actual
      // write operations are protected by RLS on the server.
      const { data } = await this.client.auth.getSession();

      // Update store with initial session
      if (data.session?.user) {
        await this.handleAuthStateChange(data.session.user);
      } else {
        this.store?.setUnauthenticated();
      }

      this.initialized = true;
    } catch (error) {
      console.error('[SupabaseAuth] Initialization failed:', error);
      this.store?.setUnauthenticated();
    }
  }

  async getCurrentUser(): Promise<AuthUser | null> {
    const {
      data: { user },
    } = await this.client.auth.getUser();
    return user ? mapSupabaseUserToAuthUser(user) : null;
  }

  /**
   * Handle authenticated state change
   * Updates store with user, subscription, and profile.
   */
  private async handleAuthStateChange(
    supabaseUser: SupabaseUser
  ): Promise<void> {
    if (!this.store) return;

    const user = mapSupabaseUserToAuthUser(supabaseUser);

    // Create default subscription (Supabase doesn't have native subscription object like we do)
    // In a real app, you might fetch this from a 'subscriptions' table
    const subscription: UserSubscription = {
      userId: user.id,
      tier:
        (typeof user.customClaims?.tier === 'string' &&
          user.customClaims.tier) ||
        SUBSCRIPTION_TIERS.FREE,
      status: 'active',
      isActive: true,
      features: [],
      subscriptionId: null,
      customerId: user.id,
      subscriptionEnd: null,
      cancelAtPeriodEnd: false,
      updatedAt: new Date().toISOString(),
    };

    // Create user profile (coerce null to undefined for UserProfile)
    const profile: UserProfile = {
      ...createDefaultUserProfile(user.id),
      email: user.email ?? undefined,
      displayName: user.displayName ?? undefined,
      photoURL: user.photoURL ?? undefined,
      role: user.role,
    };

    this.store.setAuthenticated(user, subscription, profile);
  }

  async signInWithEmailAndPassword(
    email: string,
    password: string
  ): Promise<AuthUser> {
    // SOC2 CC6.2: check brute-force lockout before attempting
    this._checkLockout(email);

    try {
      const {
        data: { user },
        error,
      } = await this.client.auth.signInWithPassword({ email, password });

      if (error) {
        this._recordFailure(email);
        throw wrapAuthError(
          error,
          'SupabaseAuth',
          'signInWithEmailAndPassword',
          { email }
        );
      }
      if (!user) {
        this._recordFailure(email);
        throw wrapAuthError(
          new Error('Sign in failed'),
          'SupabaseAuth',
          'signInWithEmailAndPassword',
          { email }
        );
      }

      this._recordSuccess(email);
      this.security?.audit({ type: 'auth.login.success', userId: user.id });

      // Store update handled by onAuthStateChanged
      return mapSupabaseUserToAuthUser(user);
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'signInWithEmailAndPassword', {
        email,
      });
    }
  }

  async createUserWithEmailAndPassword(
    email: string,
    password: string,
    metadata?: import('@donotdev/core').SignUpMetadata
  ): Promise<AuthUser> {
    try {
      const {
        data: { user },
        error,
      } = await this.client.auth.signUp({
        email,
        password,
        options: metadata ? { data: metadata } : undefined,
      });
      if (error)
        throw wrapAuthError(
          error,
          'SupabaseAuth',
          'createUserWithEmailAndPassword',
          { email }
        );
      if (!user)
        throw wrapAuthError(
          new Error('Sign up failed'),
          'SupabaseAuth',
          'createUserWithEmailAndPassword',
          { email }
        );

      // When email confirmations are enabled and the email already exists, Supabase returns a
      // fake user object with an empty `identities` array instead of an error.
      // Detect this and throw to prevent returning a ghost user to the caller.
      if (Array.isArray(user.identities) && user.identities.length === 0) {
        throw wrapAuthError(
          new Error('An account with this email already exists'),
          'SupabaseAuth',
          'createUserWithEmailAndPassword',
          { email }
        );
      }

      // Audit GDPR consent acceptance
      if (metadata) {
        this.security?.audit({
          type: 'auth.signup.consent',
          userId: user.id,
          metadata: {
            gdpr_consent_at: metadata.gdpr_consent_at ?? '',
            ...(metadata.gdpr_tos_version
              ? { gdpr_tos_version: metadata.gdpr_tos_version }
              : {}),
          },
        });
      }

      // Store update handled by onAuthStateChanged
      return mapSupabaseUserToAuthUser(user);
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(
        error,
        'SupabaseAuth',
        'createUserWithEmailAndPassword',
        { email }
      );
    }
  }

  async signOut(): Promise<void> {
    // Resolve userId BEFORE calling signOut, but never let getUser() failure
    // prevent the actual sign-out — that would leave the session active.
    let userId: string | undefined;
    try {
      const {
        data: { user },
      } = await this.client.auth.getUser();
      userId = user?.id;
    } catch {
      // Network error or expired session — proceed with sign-out anyway
    }
    await this.client.auth.signOut();
    // The "do not remember me" choice belongs to the session that just ended.
    if (hasCookieSession(this.client)) setSessionOnly(false);
    this.store?.setUnauthenticated();
    safeSessionStorage.removeItem('dndev.auth.returnTo');
    this.security?.audit({ type: 'auth.logout', userId });
  }

  async sendPasswordResetEmail(email: string): Promise<void> {
    // Rate-limit password reset requests to prevent email flooding and enumeration.
    // Key is per-email so an attacker cannot spam one address while others are unaffected.
    if (this.security) {
      await this.security.checkRateLimit(`password_reset:${email}`, 'write');
    }
    try {
      const redirectTo = this.getPasswordResetRedirectUrl();
      const { error } = await this.client.auth.resetPasswordForEmail(email, {
        redirectTo,
      });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'sendPasswordResetEmail', {
          email,
        });
      this.security?.audit({ type: 'auth.password.reset' });
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'sendPasswordResetEmail', {
        email,
      });
    }
  }

  getPasswordResetRedirectUrl(): string {
    if (!isClient()) return '';
    // Redirect to origin - PasswordResetCallback overlay auto-detects
    // hash fragments (#type=recovery) on any page
    return window.location.origin;
  }

  /**
   * Verify password reset - Supabase handles this via session token in URL.
   * When user clicks reset link, Supabase auto-authenticates with PASSWORD_RECOVERY event.
   * Returns the user's email from current session.
   */
  async verifyPasswordResetCode(_code: string): Promise<string | null> {
    try {
      const {
        data: { user },
      } = await this.client.auth.getUser();
      return user?.email ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Confirm password reset - Supabase uses updateUser since user is already
   * authenticated via the recovery token in the URL.
   */
  async confirmPasswordReset(
    _code: string,
    newPassword: string
  ): Promise<void> {
    try {
      const { error } = await this.client.auth.updateUser({
        password: newPassword,
      });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'confirmPasswordReset');
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'confirmPasswordReset');
    }
  }

  async updateUserProfile(updates: Partial<AuthUser>): Promise<void> {
    try {
      const {
        data: { user },
      } = await this.client.auth.getUser();
      if (!user)
        throw wrapAuthError(
          new Error('No current user'),
          'SupabaseAuth',
          'updateUserProfile'
        );
      const meta: Record<string, unknown> = user.user_metadata ?? {};
      const next = {
        full_name: updates.displayName ?? meta.full_name,
        name: updates.displayName ?? meta.name,
        avatar_url: updates.photoURL ?? meta.avatar_url,
      };
      const { error } = await this.client.auth.updateUser({ data: next });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'updateUserProfile');

      // Force refresh logic if needed, but onAuthStateChanged might pick it up if user object changes
      // Supabase DOES fire onAuthStateChanged on user update
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'updateUserProfile');
    }
  }

  async getAccessToken(): Promise<string | null> {
    // NOTE: getSession() reads from local storage only (no server validation).
    // For security-sensitive flows, use getUser() which validates with the server.
    // Acceptable here: the token is sent to the server which validates it via RLS/JWT verification.
    const {
      data: { session },
    } = await this.client.auth.getSession();
    return session?.access_token ?? null;
  }

  async refreshToken(): Promise<string | null> {
    const {
      data: { session },
      error,
    } = await this.client.auth.refreshSession();
    if (error) return null;
    return session?.access_token ?? null;
  }

  onAuthStateChanged(callback: (user: AuthUser | null) => void): UnsubscribeFn {
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange(
      (event: string, session: { user: SupabaseUser } | null) => {
        const user = session?.user || null;

        // PASSWORD_RECOVERY: Supabase auto-authenticates via recovery token in URL.
        // Set store flag so PasswordResetCallback component renders the new password form.
        if (event === 'PASSWORD_RECOVERY') {
          this.store?.setPasswordResetPending(true);
        }

        if (user) {
          // Await store update before firing callback so consumers see consistent state.
          this.handleAuthStateChange(user)
            .then(() => {
              callback(mapSupabaseUserToAuthUser(user));
            })
            .catch(() => {
              // Store update failed (network/null store) — still fire callback with basic user data
              // so the app isn't left in a perpetual loading state.
              callback(mapSupabaseUserToAuthUser(user));
            });
        } else {
          this.store?.setUnauthenticated();
          callback(null);
        }
      }
    );
    return () => subscription.unsubscribe();
  }

  async hasRole(role: UserRole): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user) return false;
    const userRole = user.role ?? 'guest';
    return hasRoleAccess(userRole, role);
  }

  async hasFeature(featureId: string): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user?.customClaims) return false;
    const features: unknown = user.customClaims.features;
    return Array.isArray(features) && features.includes(featureId);
  }

  async hasTier(requiredTier: string): Promise<boolean> {
    const user = await this.getCurrentUser();
    if (!user?.customClaims) return false;
    const tier: unknown = user.customClaims.tier;
    return tier === requiredTier;
  }

  async signInWithEmail(
    email: string,
    password: string
  ): Promise<AuthResult | null> {
    const user = await this.signInWithEmailAndPassword(email, password);
    return { user, success: true };
  }

  async createUserWithEmail(
    email: string,
    password: string,
    metadata?: import('@donotdev/core').SignUpMetadata
  ): Promise<AuthResult | null> {
    // Delegate to createUserWithEmailAndPassword to avoid duplicating signUp() logic.
    const user = await this.createUserWithEmailAndPassword(
      email,
      password,
      metadata
    );
    return { user, success: true, isNewUser: true };
  }

  /**
   * Popup-based OAuth for dev mode.
   * Opens a popup window that handles the full OAuth redirect flow.
   * The popup lands on the production redirect URL (or wherever Supabase sends it),
   * Supabase JS picks up the session, and we detect it via onAuthStateChange.
   *
   * This avoids redirect URL mismatches in localhost — the main window never navigates.
   */
  private async handlePopupOAuth(
    partnerId: AuthPartnerId,
    provider: OAuthProvider
  ): Promise<AuthResult | null> {
    const { data, error } = await this.client.auth.signInWithOAuth({
      provider,
      options: {
        skipBrowserRedirect: true,
        redirectTo: isClient() ? window.location.origin : undefined,
      },
    });

    if (error)
      throw wrapAuthError(error, 'SupabaseAuth', 'signInWithPartner', {
        partnerId,
      });

    if (!data?.url)
      throw wrapAuthError(
        new Error('No OAuth URL returned'),
        'SupabaseAuth',
        'signInWithPartner',
        { partnerId }
      );

    return new Promise<AuthResult | null>((resolve, reject) => {
      const width = 500;
      const height = 700;
      const left = window.screenX + (window.innerWidth - width) / 2;
      const top = window.screenY + (window.innerHeight - height) / 2;

      const popup = window.open(
        data.url,
        `supabase-oauth-${partnerId}`,
        `width=${width},height=${height},left=${left},top=${top},popup=true`
      );

      if (!popup) {
        reject(
          wrapAuthError(
            new Error(
              'Popup blocked — please allow popups for this site, or use redirect mode'
            ),
            'SupabaseAuth',
            'signInWithPartner',
            { partnerId }
          )
        );
        return;
      }

      const TIMEOUT_MS = 120_000; // 2 minutes for the user to complete OAuth
      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        clearInterval(pollTimer);
        unsubscribe();
      };

      // Listen for auth state change — Supabase session is shared via storage events
      const unsubscribe = this.onAuthStateChanged((user) => {
        if (settled) return;
        if (user) {
          cleanup();
          try {
            popup.close();
          } catch {
            // Cross-origin — popup already navigated away
          }
          resolve({ user, success: true });
        }
      });

      // Poll for popup closed (user cancelled)
      const pollTimer = setInterval(() => {
        if (settled) return;
        try {
          if (popup.closed) {
            cleanup();
            resolve(null); // User cancelled
          }
        } catch {
          // Cross-origin access error — popup still open on OAuth provider
        }
      }, 500);

      const timeout = setTimeout(() => {
        if (settled) return;
        cleanup();
        try {
          popup.close();
        } catch {
          // ignore
        }
        reject(
          wrapAuthError(
            new Error('OAuth popup timed out'),
            'SupabaseAuth',
            'signInWithPartner',
            { partnerId }
          )
        );
      }, TIMEOUT_MS);
    });
  }

  async signInWithPartner(
    partnerId: AuthPartnerId,
    method?: AuthMethod
  ): Promise<AuthResult | null> {
    const authMethod = getAuthMethod(method);

    try {
      const provider = toOAuthProvider(partnerId);

      if (authMethod === 'popup') {
        return await this.handlePopupOAuth(partnerId, provider);
      }

      // Redirect flow (production default)
      // Save current path for post-auth return-to navigation
      if (isClient()) {
        safeSessionStorage.setItem(
          'dndev.auth.returnTo',
          window.location.pathname + window.location.search
        );
      }

      const { data, error } = await this.client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: isClient() ? window.location.origin : undefined,
        },
      });

      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'signInWithPartner', {
          partnerId,
        });

      if (data?.url) {
        await redirectToExternalUrl(data.url, { validateUrl: true });
        return null;
      }
      return null;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'signInWithPartner', {
        partnerId,
      });
    }
  }

  async linkWithPartner(
    partnerId: AuthPartnerId,
    _method?: AuthMethod
  ): Promise<AuthResult | null> {
    try {
      // OAuth link returns { provider, url } (no user): the user is read after linking
      const { error } = await this.client.auth.linkIdentity({
        provider: toOAuthProvider(partnerId),
      });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'linkWithPartner', {
          partnerId,
        });
      const user = (await this.client.auth.getUser()).data?.user;
      return user
        ? { user: mapSupabaseUserToAuthUser(user), success: true }
        : null;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'linkWithPartner', {
        partnerId,
      });
    }
  }

  async signInWithGoogleCredential(
    _credential: string
  ): Promise<AuthResult | null> {
    return null;
  }

  async updatePassword(newPassword: string): Promise<void> {
    try {
      const { error } = await this.client.auth.updateUser({
        password: newPassword,
      });
      if (error) throw wrapAuthError(error, 'SupabaseAuth', 'updatePassword');
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'updatePassword');
    }
  }

  async sendEmailVerification(email?: string): Promise<void> {
    try {
      // Sign-up with email confirmation leaves no session: the caller passes the address.
      const address =
        email ?? (await this.client.auth.getUser()).data.user?.email;
      if (!address) {
        throw wrapAuthError(
          new Error('No email address to send the verification to'),
          'SupabaseAuth',
          'sendEmailVerification'
        );
      }
      const { error } = await this.client.auth.resend({
        type: 'signup',
        email: address,
      });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'sendEmailVerification');
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'sendEmailVerification');
    }
  }

  async sendSignInLinkToEmail(
    email: string,
    actionCodeSettings?: { url: string; handleCodeInApp: boolean }
  ): Promise<void> {
    try {
      const emailRedirectTo =
        actionCodeSettings?.url ??
        (typeof window !== 'undefined' ? window.location.href : undefined);
      const { error } = await this.client.auth.signInWithOtp({
        email,
        options: emailRedirectTo ? { emailRedirectTo } : undefined,
      });
      if (error)
        throw wrapAuthError(error, 'SupabaseAuth', 'sendSignInLinkToEmail', {
          email,
        });
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'sendSignInLinkToEmail', {
        email,
      });
    }
  }

  async signInWithEmailLink(
    _email: string,
    emailLink?: string
  ): Promise<AuthResult | null> {
    if (!emailLink) return null;

    try {
      // Supabase magic links have format:
      // https://project.supabase.co/auth/v1/verify?token=xxx&type=magiclink
      // OR: https://project.supabase.co/auth/v1/callback?token_hash=xxx&type=magiclink
      const url = new URL(emailLink);
      const token =
        url.searchParams.get('token') ||
        url.searchParams.get('token_hash') ||
        '';
      const type = url.searchParams.get('type') || 'magiclink';

      if (!token) {
        // Try to extract from hash as fallback (legacy format)
        const hashToken = url.hash?.slice(1) || '';
        if (!hashToken) return null;

        const {
          data: { user },
          error,
        } = await this.client.auth.verifyOtp({
          token_hash: hashToken,
          type: 'magiclink',
        });
        if (error) return null;
        return user
          ? { user: mapSupabaseUserToAuthUser(user), success: true }
          : null;
      }

      const {
        data: { user },
        error,
      } = await this.client.auth.verifyOtp({
        token_hash: token,
        type,
      });
      if (error) return null;
      return user
        ? { user: mapSupabaseUserToAuthUser(user), success: true }
        : null;
    } catch {
      // Invalid URL or other error - return null (graceful degradation)
      return null;
    }
  }

  isSignInWithEmailLink(emailLink?: string): boolean {
    if (!emailLink) return false;
    try {
      const url = new URL(emailLink);
      return (
        url.searchParams.has('token') ||
        url.searchParams.has('token_hash') ||
        url.searchParams.get('type') === 'magiclink' ||
        url.hash.includes('token_hash=') ||
        url.hash.includes('type=magiclink')
      );
    } catch {
      // Fallback to string matching if URL parsing fails
      return (
        emailLink.includes('token=') ||
        emailLink.includes('token_hash=') ||
        emailLink.includes('type=magiclink')
      );
    }
  }

  async getEmailVerificationStatus(): Promise<{ status: string }> {
    const {
      data: { user },
    } = await this.client.auth.getUser();
    return {
      status: user?.email_confirmed_at ? 'verified' : 'pending',
    };
  }

  async isEmailVerificationEnabled(): Promise<boolean> {
    return true;
  }

  async reauthenticateWithPassword(password: string): Promise<void> {
    try {
      const {
        data: { user },
      } = await this.client.auth.getUser();
      if (!user?.email)
        throw wrapAuthError(
          new Error('No email'),
          'SupabaseAuth',
          'reauthenticateWithPassword'
        );
      // Apply brute-force lockout check — reauth is a password verification and must be
      // rate-limited identically to sign-in to prevent lockout bypass (SOC2 CC6.2).
      this._checkLockout(user.email);
      const { error } = await this.client.auth.signInWithPassword({
        email: user.email,
        password,
      });
      if (error) {
        this._recordFailure(user.email);
        throw wrapAuthError(
          error,
          'SupabaseAuth',
          'reauthenticateWithPassword'
        );
      }
      this._recordSuccess(user.email);
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'reauthenticateWithPassword');
    }
  }

  async reauthenticateWithProvider(
    partnerId: AuthPartnerId,
    method?: AuthMethod
  ): Promise<void> {
    const authMethod = getAuthMethod(method);

    try {
      const provider = toOAuthProvider(partnerId);

      if (authMethod === 'popup') {
        await this.handlePopupOAuth(partnerId, provider);
        return;
      }

      const { data, error } = await this.client.auth.signInWithOAuth({
        provider,
        options: {
          redirectTo: isClient() ? window.location.origin : undefined,
        },
      });
      if (error)
        throw wrapAuthError(
          error,
          'SupabaseAuth',
          'reauthenticateWithProvider',
          { partnerId }
        );
      if (data?.url && isClient()) {
        await redirectToExternalUrl(data.url, { validateUrl: true });
      }
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'reauthenticateWithProvider', {
        partnerId,
      });
    }
  }

  /**
   * Delete current user account. Delegates to callable provider (Edge Function) when configured,
   * otherwise throws with an actionable error message.
   */
  async deleteAccount(_password?: string): Promise<void> {
    try {
      if (hasProvider('callable')) {
        const callable = getProvider('callable');
        // Do NOT pass userId from the client — the server must derive it from the JWT.
        // Sending client-supplied userId would allow any authenticated user to delete
        // arbitrary accounts by passing a different userId in the request payload.
        await callable.call('delete-account', {});
        await this.client.auth.signOut();
        return;
      }

      const err = Object.assign(
        new Error(
          'Account deletion requires a server endpoint. Configure a callable provider or deploy a delete-account Edge Function.'
        ),
        { code: 'DELETE_ACCOUNT_REQUIRES_SERVER' }
      );
      throw wrapAuthError(err, 'SupabaseAuth', 'deleteAccount');
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseAuth', 'deleteAccount');
    }
  }

  /** Remember me needs the cookie client (createBrowserClient); localStorage cannot. */
  supportsRememberMe(): boolean {
    return hasCookieSession(this.client);
  }

  /**
   * Persistent (`true`) or session-only (`false`) auth cookies for the next sign-in.
   * Throws on a client that does not keep its session in cookies.
   */
  async setRememberMe(remember: boolean): Promise<void> {
    if (!this.supportsRememberMe()) {
      throw wrapAuthError(
        new Error(
          'Remember me needs the cookie client: create the Supabase client with createBrowserClient from @donotdev/supabase'
        ),
        'SupabaseAuth',
        'setRememberMe'
      );
    }
    setSessionOnly(!remember);
  }
}
