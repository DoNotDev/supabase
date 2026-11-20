// packages/providers/supabase/src/server/databaseWebhook.ts

/**
 * @fileoverview Supabase database webhook payload
 * @description Reader of the body a Supabase database webhook POSTs
 * (https://supabase.com/docs/guides/database/webhooks):
 * `{ type, table, schema, record, old_record }`. Used by the generated Next revalidation
 * route (`src/app/api/dndev/revalidate`), which maps the change to the cached pages.
 *
 * @version 0.1.0
 * @since 0.3.2
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { defaultFieldMapper } from '../common/fieldMapper';

/** A row as Postgres sends it (column names). */
const ROW = v.record(v.string(), v.unknown());

/** Body of a Supabase database webhook (one row event). */
const WEBHOOK_SCHEMA = v.variant('type', [
  v.object({
    type: v.literal('INSERT'),
    table: v.string(),
    schema: v.string(),
    record: ROW,
    old_record: v.null(),
  }),
  v.object({
    type: v.literal('UPDATE'),
    table: v.string(),
    schema: v.string(),
    record: ROW,
    old_record: ROW,
  }),
  v.object({
    type: v.literal('DELETE'),
    table: v.string(),
    schema: v.string(),
    record: v.null(),
    old_record: ROW,
  }),
]);

/**
 * A row change from a database webhook, rows with app field names (camelCase).
 *
 * @version 0.1.0
 * @since 0.3.2
 */
export interface DatabaseWebhookChange {
  /** Event of the row */
  type: 'INSERT' | 'UPDATE' | 'DELETE';
  /** Table name (the entity's collection) */
  table: string;
  /** Postgres schema of the table */
  schema: string;
  /** Row after the change (`null` on delete) */
  record: Record<string, unknown> | null;
  /** Row before the change (`null` on insert) */
  oldRecord: Record<string, unknown> | null;
}

/**
 * Read a Supabase database webhook body. Rows are mapped to app field names with the
 * adapter's default mapping (snake_case column → camelCase field), so a route param
 * (`:slug`, `:productId`) reads the same field as on the public reader's records.
 *
 * @param body - Parsed JSON body of the webhook request
 * @returns The change
 * @throws {Error} When the body is not a row event (`type` INSERT / UPDATE / DELETE with
 *   the matching `record` / `old_record`); the message names what is wrong
 *
 * @example
 * ```ts
 * const change = readDatabaseWebhook(await request.json());
 * // { type: 'UPDATE', table: 'products', schema: 'public', record: { slug: 'x', … }, oldRecord: { … } }
 * ```
 *
 * @version 0.1.0
 * @since 0.3.2
 */
export function readDatabaseWebhook(body: unknown): DatabaseWebhookChange {
  const result = v.safeParse(WEBHOOK_SCHEMA, body);
  if (!result.success) {
    throw new Error(
      `Not a Supabase database webhook row event: ${result.issues
        .map((issue) => `${v.getDotPath(issue) ?? 'body'}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const { type, table, schema, record, old_record } = result.output;
  return {
    type,
    table,
    schema,
    record: record && defaultFieldMapper.fromBackendRow(record),
    oldRecord: old_record && defaultFieldMapper.fromBackendRow(old_record),
  };
}
