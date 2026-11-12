// packages/providers/supabase/src/server/authAdapter.ts

/**
 * @fileoverview Supabase Server Auth Adapter
 * @description IServerAuthAdapter implementation using Supabase Auth Admin API.
 * Requires a Supabase client created with the secret key (sb_secret_...) or service_role key (legacy).
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  IServerAuthAdapter,
  VerifiedToken,
  ServerUserRecord,
} from '@donotdev/core/server';
import { wrapAuthError, DoNotDevError } from '@donotdev/core/server';

// =============================================================================
// Server client factory
// =============================================================================

/**
 * Create a Supabase client with the secret key (sb_secret_...) or service_role key (legacy) for server-side auth admin.
 * Use this only on the server (Node.js); never expose the secret key to the client.
 *
 * @param url - Supabase project URL
 * @param secretKey - Secret key (sb_secret_...) or service_role key (legacy)
 *
 * @version 0.1.0
 * @since 0.0.1
 */
export function createServerClient(
  url: string,
  secretKey: string
): SupabaseClient {
  return createClient(url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

/** A string property of an error-like value. */
function stringProp(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return undefined;
  }
  const prop: unknown = Reflect.get(value, key);
  return typeof prop === 'string' ? prop : undefined;
}

/** An SDK auth error as an Error (non-Error payloads keep their message). */
function toAuthError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(
    stringProp(error, 'message') ||
      stringProp(error, 'error_description') ||
      String(error)
  );
}

// =============================================================================
// Supabase Server Auth Adapter
// =============================================================================

/**
 * Supabase server auth adapter implementing IServerAuthAdapter.
 * Pass a Supabase client created with createServerClient(url, secretKey).
 * Secret key can be SUPABASE_SECRET_KEY (sb_secret_...) or SUPABASE_SERVICE_ROLE_KEY (legacy).
 *
 * @version 0.1.0
 * @since 0.0.1
 */
export class SupabaseServerAuthAdapter implements IServerAuthAdapter {
  constructor(private readonly client: SupabaseClient) {}

  async verifyToken(token: string): Promise<VerifiedToken> {
    try {
      const {
        data: { user },
        error,
      } = await this.client.auth.getUser(token);

      if (error) {
        throw wrapAuthError(
          toAuthError(error),
          'SupabaseServerAuthAdapter',
          'verifyToken'
        );
      }
      if (!user) {
        throw wrapAuthError(
          new Error('Invalid token'),
          'SupabaseServerAuthAdapter',
          'verifyToken'
        );
      }

      return {
        uid: user.id,
        email: user.email ?? undefined,
        claims: {
          ...user.user_metadata,
          ...user.app_metadata,
        },
      };
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(error, 'SupabaseServerAuthAdapter', 'verifyToken');
    }
  }

  async getUser(uid: string): Promise<ServerUserRecord | null> {
    const {
      data: { user },
      error,
    } = await this.client.auth.admin.getUserById(uid);

    if (error || !user) return null;

    const meta: Record<string, unknown> = user.user_metadata ?? {};
    const displayName =
      typeof meta.full_name === 'string'
        ? meta.full_name
        : typeof meta.name === 'string'
          ? meta.name
          : undefined;
    return {
      uid: user.id,
      email: user.email ?? undefined,
      displayName,
      customClaims: {
        ...user.user_metadata,
        ...user.app_metadata,
      },
    };
  }

  async setCustomClaims(
    uid: string,
    claims: Record<string, unknown>
  ): Promise<void> {
    try {
      // Pass only the new claims to updateUserById — Supabase merges app_metadata at the
      // Postgres JSONB level (jsonb || jsonb), which is atomic and eliminates the
      // read-modify-write race that would occur if we fetched then merged in application code.
      // Use only app_metadata — never user_metadata (user-editable) to prevent privilege escalation.
      const { error } = await this.client.auth.admin.updateUserById(uid, {
        app_metadata: claims,
      });
      if (error) {
        throw wrapAuthError(
          toAuthError(error),
          'SupabaseServerAuthAdapter',
          'setCustomClaims',
          { uid }
        );
      }
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapAuthError(
        error,
        'SupabaseServerAuthAdapter',
        'setCustomClaims',
        { uid }
      );
    }
  }
}
