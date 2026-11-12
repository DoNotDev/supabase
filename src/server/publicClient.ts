// packages/providers/supabase/src/server/publicClient.ts

/**
 * @fileoverview Supabase public server client
 * @description Supabase client for server reads with the public (anonymous) role: what a
 * signed-out visitor can read, enforced by RLS. Used by the routes the framework
 * generates for crawlers (sitemap, llms.txt). No session, no token refresh.
 *
 * @version 0.1.0
 * @since 0.2.3
 * @author AMBROISE PARK Consulting
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Create a server-side Supabase client with the publishable (or legacy anon) key.
 * Reads run as the anonymous role, so RLS returns only public rows and columns.
 *
 * @param url - Project URL (`https://<ref>.supabase.co`)
 * @param publicKey - Publishable (sb_publishable_...) or legacy anon key, never the secret key
 * @returns Supabase client without session persistence
 *
 * @example
 * ```ts
 * const crud = new SupabaseCrudAdapter(createPublicServerClient(url, publicKey));
 * ```
 *
 * @version 0.1.0
 * @since 0.2.3
 */
export function createPublicServerClient(
  url: string,
  publicKey: string
): SupabaseClient {
  return createClient(url, publicKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
