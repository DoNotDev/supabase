// packages/providers/supabase/src/index.ts

/**
 * @donotdev/supabase — Supabase provider for DoNotDev
 * Client-only exports: adapters and client init.
 *
 * @packageDocumentation
 */

export * from './client';
export {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
  type SupabaseFieldMapper,
} from './common/fieldMapper';
