// packages/providers/supabase/src/common/sessionCookie.ts

/**
 * @fileoverview Supabase session from request cookies
 * @description Pure reader of the `sb-<ref>-auth-token` cookie @supabase/ssr writes,
 * shared by SupabaseAuth.readSessionSnapshot (server render) and
 * refreshSupabaseSession (generated Next `proxy.ts`, after the session is verified).
 * No client: works in any server runtime.
 *
 * @version 0.2.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */

import type { User as SupabaseUser } from '@supabase/supabase-js';
import * as v from 'valibot';
import { stringFromBase64URL } from '@supabase/ssr';

import type { AuthSessionSnapshot, AuthUser } from '@donotdev/core';

/** Prefix @supabase/ssr puts on base64url-encoded cookie values. */
const SESSION_COOKIE_BASE64_PREFIX = 'base64-';

/** Name of a Supabase auth session cookie, whole or one chunk (`.0`, `.1`…); group 1 = key. */
export const SUPABASE_SESSION_COOKIE = /^(sb-[^.]+-auth-token)(?:\.\d+)?$/;

/** Session cookie marking "do not remember me": present = auth cookies are session-only. */
export const SESSION_ONLY_COOKIE = 'dndev-auth-session-only';

/** Fields of a Supabase user the mapping reads (an SDK `User`, or one read from a cookie). */
type MappableSupabaseUser = Pick<SupabaseUser, 'id'> & {
  email?: string | null;
  email_confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
  app_metadata?: Record<string, unknown> | null;
};

/** User inside the session cookie (other fields kept, unread). */
const COOKIE_USER_SCHEMA = v.looseObject({
  id: v.string(),
  email: v.optional(v.nullable(v.string())),
  email_confirmed_at: v.optional(v.nullable(v.string())),
  user_metadata: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
  app_metadata: v.optional(v.nullable(v.record(v.string(), v.unknown()))),
});

/** Session JSON @supabase/ssr stores in the auth cookie. */
const COOKIE_SESSION_SCHEMA = v.nullable(
  v.looseObject({
    user: v.optional(v.nullable(COOKIE_USER_SCHEMA)),
    access_token: v.optional(v.unknown()),
    expires_at: v.optional(v.unknown()),
  })
);

/** A metadata value when it is a string. */
function metaString(
  meta: Record<string, unknown>,
  key: string
): string | undefined {
  const value = meta[key];
  return typeof value === 'string' ? value : undefined;
}

/** Map a Supabase user to the framework AuthUser. */
export function mapSupabaseUserToAuthUser(user: MappableSupabaseUser): AuthUser {
  const meta = user.user_metadata ?? {};
  const appMeta = user.app_metadata ?? {};
  return {
    id: user.id,
    email: user.email ?? undefined,
    displayName: metaString(meta, 'full_name') ?? metaString(meta, 'name'),
    photoURL: metaString(meta, 'avatar_url'),
    emailVerified: !!user.email_confirmed_at,
    role: metaString(appMeta, 'role') ?? 'guest',
    customClaims: { ...meta, ...appMeta },
  };
}

/**
 * Signed-in state from a Cookie header, for a Supabase client whose session lives in
 * cookies (`createBrowserClient`). Reads `sb-<ref>-auth-token` (whole or chunked `.0`,
 * `.1`…, optionally `base64-` encoded). Not verified: display only, data access stays
 * enforced by RLS. Redirect decisions use refreshSupabaseSession, which verifies first.
 *
 * A session whose access token has expired is not a signed-in user: the refresh token
 * may be dead, and only a refresh tells (the proxy's refreshSupabaseSession, or the
 * browser client). It reads as "cannot tell", so the client waits for the provider.
 * Behind the generated proxy the render always gets a refreshed, valid cookie.
 *
 * @param cookieHeader - The request's `Cookie` header
 * @returns `{ user: null }` signed out, `{ user, accessToken? }` signed in with an
 * unexpired access token, `null` cannot tell (expired or undated session, several
 * projects' cookies, partially written cookie)
 *
 * @version 0.2.0
 * @since 0.2.3
 */
export function readSupabaseSessionCookie(
  cookieHeader: string
): AuthSessionSnapshot | null {
  const cookies = new Map<string, string>();
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const value = part.slice(eq + 1).trim();
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Kept raw: a malformed session cookie must read as "cannot tell", not absent.
    }
    cookies.set(part.slice(0, eq).trim(), decoded);
  }

  const keys = new Set<string>();
  for (const name of cookies.keys()) {
    const match = name.match(SUPABASE_SESSION_COOKIE);
    if (match?.[1]) keys.add(match[1]);
  }
  const [key, ...otherKeys] = keys;
  if (key === undefined) return { user: null };
  // Several Supabase projects on this domain: the cookie for this client is unknown.
  if (otherKeys.length > 0) return null;

  let raw = cookies.get(key) ?? null;
  if (raw === null) {
    const chunks: string[] = [];
    for (
      let i = 0, chunk = cookies.get(`${key}.0`);
      chunk !== undefined;
      chunk = cookies.get(`${key}.${++i}`)
    ) {
      chunks.push(chunk);
    }
    raw = chunks.length > 0 ? chunks.join('') : null;
  }
  if (raw === null) return { user: null };

  try {
    const json = raw.startsWith(SESSION_COOKIE_BASE64_PREFIX)
      ? stringFromBase64URL(raw.slice(SESSION_COOKIE_BASE64_PREFIX.length))
      : raw;
    // Validated, not cast: a malformed cookie throws and reads as "cannot tell"
    const session = v.parse(COOKIE_SESSION_SCHEMA, JSON.parse(json));
    if (!session?.user) return { user: null };
    // Expired (or undated) access token: signed in only if a refresh succeeds, which
    // this reader cannot do. Cannot tell.
    if (
      typeof session.expires_at !== 'number' ||
      session.expires_at * 1000 <= Date.now()
    ) {
      return null;
    }
    const user = mapSupabaseUserToAuthUser(session.user);
    // Token for request-scoped reads during the server render, only while it stays
    // valid for the render (a minute of margin); an expiring one would just be refused.
    return typeof session.access_token === 'string' &&
      session.expires_at * 1000 > Date.now() + 60_000
      ? { user, accessToken: session.access_token }
      : { user };
  } catch {
    // Partially written or foreign cookie: let the provider decide once ready.
    return null;
  }
}
