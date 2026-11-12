// packages/providers/supabase/src/client/index.ts

/**
 * @fileoverview Supabase client exports
 * @description CRUD adapter, storage adapter, and auth provider for browser use.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

export { SupabaseCallableProvider } from './callableProvider';
export { SupabaseCrudAdapter } from '../common/crudAdapter';
export { SupabaseStorageAdapter } from './storageAdapter';
export { SupabaseAuth } from './auth';
export { createBrowserClient } from './browserClient';

export { createClient } from '@supabase/supabase-js';
export type { SupabaseClient } from '@supabase/supabase-js';
