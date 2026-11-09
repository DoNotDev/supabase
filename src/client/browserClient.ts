// packages/providers/supabase/src/client/browserClient.ts

/**
 * @fileoverview Supabase client with the session in cookies
 * @description `createBrowserClient` (@supabase/ssr) keeps the auth session in cookies
 * instead of localStorage, so the server can read who is signed in from the request
 * (SupabaseAuth.readSessionSnapshot) and render that state. The same call works during
 * server rendering (no session there, no token refresh).
 *
 * @version 0.1.0
 * @since 0.1.46
 * @author AMBROISE PARK Consulting
 */

import { createBrowserClient as createSsrBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Clients created here: their session lives in cookies. */
const cookieSessionClients = new WeakSet<object>();

/**
 * Create the app's Supabase client with the auth session stored in cookies.
 * Use it instead of `createClient` in the app's provider setup; the server then knows
 * the signed-in state on the first render (no signed-out flash).
 *
 * @param url - Project URL (`https://<ref>.supabase.co`)
 * @param publicKey - Publishable (or legacy anon) key
 *
 * @version 0.1.0
 * @since 0.1.46
 * @author AMBROISE PARK Consulting
 */
export function createBrowserClient(
  url: string,
  publicKey: string
): SupabaseClient {
  const client = createSsrBrowserClient(url, publicKey) as SupabaseClient;
  cookieSessionClients.add(client);
  return client;
}

/** Whether the client keeps its session in cookies (created by createBrowserClient). */
export function hasCookieSession(client: SupabaseClient): boolean {
  return cookieSessionClients.has(client);
}
