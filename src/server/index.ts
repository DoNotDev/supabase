// packages/providers/supabase/src/server/index.ts

/**
 * @donotdev/supabase/server — Server exports: auth admin (SupabaseServerAuthAdapter,
 * createServerClient), public reads (SupabaseCrudAdapter, createPublicServerClient) and
 * the session check and refresh of the generated Next proxy (hasSupabaseSessionCookie,
 * refreshSupabaseSession) and the database webhook reader of the generated revalidation
 * route (readDatabaseWebhook).
 *
 * @packageDocumentation
 */

export { SupabaseServerAuthAdapter, createServerClient } from './authAdapter';
export { createPublicServerClient } from './publicClient';
export { SupabaseCrudAdapter } from '../common/crudAdapter';
export { readSupabaseSessionCookie } from '../common/sessionCookie';
export {
  hasSupabaseSessionCookie,
  refreshSupabaseSession,
  type ProxyRequestCookies,
  type ProxyRequestHeaders,
  type ProxyResponse,
  type SupabaseProxySession,
} from './proxySession';
export {
  readDatabaseWebhook,
  type DatabaseWebhookChange,
} from './databaseWebhook';
export {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
  type SupabaseFieldMapper,
} from '../common/fieldMapper';
