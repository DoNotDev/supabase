// packages/providers/supabase/src/server/publicReader.ts

/**
 * @fileoverview Supabase public reader
 * @description The Supabase public server reader of the framework's record readers
 * (generated sitemap, llms.txt and entity pages, Vite record pages): records as RLS
 * returns them to a signed-out visitor, keyed by the entity's field names.
 *
 * @version 0.1.0
 * @since 0.3.2
 * @author AMBROISE PARK Consulting
 */

import type {
  dndevSchema,
  PaginatedQueryResult,
  QueryOptions,
} from '@donotdev/core';

import { SupabaseCrudAdapter } from '../common/crudAdapter';

/**
 * Anonymous `SupabaseCrudAdapter` (`createPublicServerClient`) whose `query` reads every
 * column RLS returns to a signed-out visitor (`select=*`), keyed by the entity's field
 * names from the schema (`availability_date` stays `availability_date`), without the
 * client-side column choice and visibility filter of a role. Its records feed
 * server-side derivations (sitemap URLs and `lastmod`, llms.txt, entity page metadata
 * and JSON-LD), which output only their own fields; what a visitor may read is RLS's
 * decision. Same contract as `FirestorePublicReader`.
 *
 * @example
 * ```ts
 * const CRUD = new SupabasePublicReader(createPublicServerClient(url, publicKey));
 * const { items } = await CRUD.query('products', {
 *   where: [{ field: 'status', operator: 'not-in', value: ['draft', 'deleted'] }],
 *   limit: 1000,
 * }, createSchemas(productEntity).get);
 * ```
 *
 * @version 0.1.0
 * @since 0.3.2
 */
export class SupabasePublicReader extends SupabaseCrudAdapter {
  /**
   * Query a table as a signed-out visitor: every column RLS returns, unfiltered.
   *
   * @param collection - Table
   * @param options - Filters, order, cursor and page size
   * @param schema - The entity's read schema: names the rows' fields
   * @returns Page of rows with their `id`, keyed by the entity's field names
   * @throws CRUD error when RLS denies the query or the read fails
   * @since 0.3.2
   */
  override query<T>(
    collection: string,
    options: QueryOptions,
    schema?: dndevSchema<unknown>
  ): Promise<PaginatedQueryResult<T>> {
    return this.queryAs<T>(null, collection, options, schema);
  }
}
