// packages/providers/supabase/src/server/index.ts

/**
 * @donotdev/supabase/server — Server-only exports (SupabaseServerAuthAdapter, createServerClient).
 *
 * @packageDocumentation
 */

export { SupabaseServerAuthAdapter, createServerClient } from './authAdapter';
export {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
  type SupabaseFieldMapper,
} from '../common/fieldMapper';
