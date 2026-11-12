// packages/providers/supabase/src/common/crudAdapter.ts

/**
 * @fileoverview Supabase CRUD Adapter
 * @description ICrudAdapter implementation using Supabase PostgREST. Collection name = table name.
 *
 * **Caching contract:**
 * This adapter is unaware of caching — CrudService owns TanStack Query entirely.
 * The adapter only fetches/writes; CrudService updates GET + list caches after every mutation
 * so the UI never refetches. Default staleTime is Infinity.
 *
 * **Audit fields (`createdById` / `updatedById`):**
 * `add()` injects these from the active Supabase session (stored as created_by_id/updated_by_id in DB).
 * The adapter's field mapper converts app ↔ backend names at the boundary only.
 *
 * **Field mapping (single boundary):**
 * Write paths convert app field names to backend column names (snake_case) via blind camelToSnake.
 * Read paths use an entity-aware mapper that preserves entity field names as defined in the schema
 * (which may be snake_case or camelCase) so `filterVisibleFields` can match them.
 *
 * **Cursor pagination:**
 * `QueryOptions.startAfter` must be the value of the first `orderBy` field from the last row
 * of the previous page — i.e. pass `lastVisible` returned by `query()` directly as `startAfter`.
 *
 * **Multi-tenant subscriptions:**
 * `subscribeToCollection()` translates equality `where` clauses (e.g. scope filters) into
 * Supabase channel-level filters so only relevant tenant rows trigger the callback.
 * Each unique filter set gets its own named channel to prevent cross-tenant notifications.
 * Rapid table changes are debounced (100 ms) so bursts of writes coalesce into one re-fetch.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as v from 'valibot';

import {
  BulkCollisionError,
  detectBulkCollisions,
  wrapCrudError,
  validateWithSchema,
  DoNotDevError,
  CRUD_OPERATORS,
  ERROR_CODES,
  filterVisibleFields,
  getVisibleFields,
} from '@donotdev/core';
import type {
  BulkFailure,
  BulkOperations,
  BulkResult,
  ICrudAdapter,
  QueryOptions,
  QueryWhereClause,
  PaginatedQueryResult,
  DocumentSubscriptionCallback,
  CollectionSubscriptionCallback,
  CrudOperationOptions,
  dndevSchema,
} from '@donotdev/core';
import type { UserRole } from '@donotdev/core';

import {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
} from './fieldMapper';

const DEFAULT_ID_COLUMN = 'id';

/** Rows a write returns with `.select(idColumn)` (null when the request failed). */
const RETURNED_ROWS_SCHEMA = v.nullable(v.array(v.record(v.string(), v.unknown())));
/** A returned row's id column value. */
const ROW_ID_SCHEMA = v.union([v.string(), v.number()]);
/** One PostgREST row: the select string is built at runtime, so the SDK cannot type it. */
const ROW_SCHEMA = v.record(v.string(), v.unknown());
/** Rows of a query (null when the request failed). */
const QUERY_ROWS_SCHEMA = v.nullable(v.array(ROW_SCHEMA));
/** JWT claims read for column choice (other claims are ignored). */
const JWT_CLAIMS_SCHEMA = v.object({
  app_metadata: v.optional(v.record(v.string(), v.unknown())),
});

/** Ids (or rows) per bulk request: keeps `in.(…)` filters well under URL limits. */
const BULK_CHUNK_SIZE = 100;
/** Bulk requests in flight at once. */
const BULK_CONCURRENCY = 6;

/** Split `items` into consecutive chunks of at most `size`. */
function chunked<I>(items: I[], size: number): I[][] {
  const chunks: I[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/** Run `tasks` with at most `limit` in flight; resolves when all have settled. */
async function runConcurrently(
  tasks: Array<() => Promise<void>>,
  limit: number
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next++]!;
      await task();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, worker)
  );
}

/** Message of a thrown value or a PostgREST error object. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String(err.message);
  }
  return String(err);
}

/** Strip timestamp fields so the DB sets them (DEFAULT now() / trigger). */
/**
 * Entity data (`T`) as a row record.
 * why: ICrudAdapter's `T` is unconstrained, so TS cannot prove an entity is a record.
 */
function entityRecord<T>(data: T): Record<string, unknown> {
  return data as Record<string, unknown>;
}

/**
 * A normalized row as the caller's entity type.
 * why: ICrudAdapter's `T` is caller-asserted; rows are mapped and visibility-filtered, not validated against `T`.
 */
function asEntity<T>(row: Record<string, unknown>): T {
  return row as T;
}

/**
 * The SDK builder as the structural filter chain used by query().
 * why: supabase-js types a runtime select string as a parser error type; the chain methods used are the same.
 */
function toFilterBuilder<B>(builder: B): SbFilterBuilder {
  return builder as unknown as SbFilterBuilder;
}

function stripTimestampFields(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const {
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    created_at: _ca,
    updated_at: _ua,
    ...rest
  } = payload;
  return rest;
}

/** Supabase PostgREST filter/query builder chain */
type SbFilterBuilder = {
  eq(column: string, value: unknown): SbFilterBuilder;
  neq(column: string, value: unknown): SbFilterBuilder;
  lt(column: string, value: unknown): SbFilterBuilder;
  lte(column: string, value: unknown): SbFilterBuilder;
  gt(column: string, value: unknown): SbFilterBuilder;
  gte(column: string, value: unknown): SbFilterBuilder;
  in(column: string, values: unknown[]): SbFilterBuilder;
  contains(column: string, value: unknown): SbFilterBuilder;
  /** PostgREST `&&` — array overlaps (contains any of the given values) */
  overlaps(column: string, value: unknown[]): SbFilterBuilder;
  not(column: string, op: string, value: unknown): SbFilterBuilder;
  order(column: string, opts: { ascending: boolean }): SbFilterBuilder;
  limit(n: number): SbFilterBuilder;
  then<T>(
    onfulfilled?: (value: {
      data: unknown;
      error: unknown;
      count?: number;
    }) => T | PromiseLike<T>
  ): Promise<T>;
};

/**
 * Validates that a value is safe for use in PostgREST filter expressions.
 * PostgREST operators use dots, parentheses, and commas — reject values containing these
 * to prevent filter injection (e.g. `id=eq.foo.or(admin=eq.true)`).
 */
function sanitizePostgrestFilterValue(value: string): string {
  // Allow dots (valid in string IDs, emails, etc.) — only reject parentheses and commas
  // which are PostgREST operator characters (e.g. `or(...)`, `in(a,b)`).
  if (/[(),]/.test(value)) {
    throw new Error(
      '[crudAdapter] Invalid filter value: contains PostgREST operator characters'
    );
  }
  return value;
}

/**
 * PostgREST list literal for `not(col, 'in', …)`: `("a","b")`. `.not()` serializes its
 * value verbatim (`not.in.a,b` without parentheses is rejected by PostgREST), unlike
 * `.in()`, which formats the list itself. Values are double-quoted so commas and
 * parentheses inside a value stay literal.
 */
function postgrestList(values: readonly unknown[]): string {
  return `(${values.map((v) => JSON.stringify(String(v))).join(',')})`;
}

/** Ensure field is a string before mapper (framework must never pass schema/object as field). */
function ensureStringField(field: unknown, context: string): string {
  if (typeof field === 'string') return field;
  console.warn(
    `[SupabaseCrudAdapter] ${context}.field was not a string (got ${typeof field}). ` +
      'Coercing to string. Check framework code that builds orderBy/where — use field name string, not schema or config object.'
  );
  return String(field);
}

function applyWhere(
  q: SbFilterBuilder,
  clause: QueryWhereClause,
  toBackendField: (appField: string) => string
): SbFilterBuilder {
  const { field, operator, value } = clause;
  const col = toBackendField(ensureStringField(field, 'where'));
  switch (operator) {
    case CRUD_OPERATORS.EQ:
      return q.eq(col, value);
    case CRUD_OPERATORS.NEQ:
      return q.neq(col, value);
    case CRUD_OPERATORS.LT:
      return q.lt(col, value);
    case CRUD_OPERATORS.LTE:
      return q.lte(col, value);
    case CRUD_OPERATORS.GT:
      return q.gt(col, value);
    case CRUD_OPERATORS.GTE:
      return q.gte(col, value);
    case CRUD_OPERATORS.IN:
      return q.in(col, Array.isArray(value) ? value : [value]);
    case CRUD_OPERATORS.NOT_IN:
      return q.not(
        col,
        'in',
        postgrestList(Array.isArray(value) ? value : [value])
      );
    case CRUD_OPERATORS.ARRAY_CONTAINS:
      return q.contains(col, value);
    case CRUD_OPERATORS.ARRAY_CONTAINS_ANY:
      if (!Array.isArray(value) || value.length === 0) {
        throw new DoNotDevError(
          'SupabaseCrudAdapter: ARRAY_CONTAINS_ANY requires a non-empty array',
          ERROR_CODES.INVALID_ARGUMENT,
          { context: { operator, field } }
        );
      }
      return q.overlaps(col, value);
    default:
      throw new DoNotDevError(
        `SupabaseCrudAdapter: unsupported operator "${String(operator)}"`,
        ERROR_CODES.INVALID_ARGUMENT,
        { context: { operator, field } }
      );
  }
}

// =============================================================================
// SupabaseCrudAdapter
// =============================================================================

/**
 * Supabase CRUD adapter. Uses entity collection name as table name.
 * Tables must have an `id` column (text or uuid).
 *
 * @param client - Supabase client instance
 * @param idColumn - Primary key column name (default: `'id'`)
 *
 * @version 0.1.0
 * @since 0.0.1
 */
/**
 * Framework role from Supabase `app_metadata` (JWT claims or session user).
 * Signed in without an explicit role = 'user'; no session = 'guest'.
 */
function roleFromAppMetadata(
  signedIn: boolean,
  meta: Record<string, unknown> | undefined | null
): UserRole {
  if (!signedIn) return 'guest';
  if (meta) {
    if (meta.role === 'super' || meta.isSuper === true) return 'super';
    if (meta.role === 'admin' || meta.isAdmin === true) return 'admin';
    if (typeof meta.role === 'string' && meta.role) return meta.role;
  }
  return 'user';
}

/** Claims of a JWT (payload only, not verified: column choice, never authorisation). */
function decodeJwtPayload(
  token: string
): { app_metadata?: Record<string, unknown> } | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    return v.parse(
      JWT_CLAIMS_SCHEMA,
      JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
        )
      )
    );
  } catch {
    return null;
  }
}

/** Short-lived role cache (30s) — avoids a getSession() call on every read/query. */
interface RoleCache {
  role: UserRole;
  expiresAt: number;
}

export class SupabaseCrudAdapter implements ICrudAdapter {
  /**
   * Supabase enforces field-level and row-level security at the Postgres layer via RLS
   * and column-level grants. The framework visibility gate is not needed here.
   *
   * **Required:** RLS must be enabled on every table this adapter accesses.
   * Without RLS, authenticated users can read all rows and columns.
   *
   * ```sql
   * ALTER TABLE your_table ENABLE ROW LEVEL SECURITY;
   * -- Row-level: users see only their own rows
   * CREATE POLICY "read_own" ON your_table FOR SELECT USING (auth.uid() = user_id);
   * -- Field-level: restrict columns per role
   * REVOKE SELECT ON your_table FROM anon;
   * GRANT SELECT (id, public_col) ON your_table TO anon;
   * GRANT SELECT ON your_table TO authenticated;
   * ```
   */
  readonly dbLevelSecurity = true;
  private readonly mapper: typeof defaultFieldMapper;
  private _roleCache: RoleCache | null = null;
  /**
   * Translation columns (`<column>_i18n`, fields defined with `i18n: true`) the database
   * does not have yet, per table. Left out of selects: reads serve the default language
   * until the migration adds them. Shared with forAccessToken views (prototype).
   */
  private readonly missingTranslationColumns = new Map<string, Set<string>>();
  private readonly _unsubscribeAuthState: () => void;

  constructor(
    private readonly client: SupabaseClient,
    private readonly idColumn: string = DEFAULT_ID_COLUMN
  ) {
    this.mapper = defaultFieldMapper;

    // Invalidate the role cache on every auth state change so a signed-out user never
    // inherits the previous user's cached role (e.g., admin → guest on shared device).
    const {
      data: { subscription },
    } = this.client.auth.onAuthStateChange(() => {
      this._roleCache = null;
    });
    this._unsubscribeAuthState = () => subscription.unsubscribe();
  }

  /**
   * Request-scoped view (ICrudAdapter.forAccessToken): reads send the visitor's access
   * token, and columns are chosen for the role in its claims. Shares the client and
   * mapper; registers no auth listener. Postgres (PostgREST) verifies the token, so a
   * forged or expired one only gets an error, never someone else's rows.
   */
  forAccessToken(accessToken: string): SupabaseCrudAdapter {
    const claims = decodeJwtPayload(accessToken);
    // why: Object.create returns any; the view is a prototype child of this adapter
    const view = Object.create(this) as SupabaseCrudAdapter;
    Object.defineProperties(view, {
      requestToken: { value: accessToken },
      requestRole: {
        value: roleFromAppMetadata(true, claims?.app_metadata),
      },
    });
    return view;
  }

  /** Request-scoped token (forAccessToken view), else unset. */
  private readonly requestToken?: string;
  /** Role of the request-scoped token, else unset. */
  private readonly requestRole?: UserRole;

  /** Sends the request-scoped token on a read, when this is a forAccessToken view. */
  private asRequester<B extends { setHeader(name: string, value: string): B }>(
    builder: B
  ): B {
    return this.requestToken
      ? builder.setHeader('Authorization', `Bearer ${this.requestToken}`)
      : builder;
  }

  /**
   * Invalidate the role cache immediately.
   * Call this when you know the session has changed (e.g., after sign-out) and cannot
   * wait for the auth state listener to fire.
   */
  invalidateRoleCache(): void {
    this._roleCache = null;
  }

  /**
   * Remove the auth state listener. Call when the adapter is no longer needed
   * to prevent memory leaks in long-running server processes.
   */
  dispose(): void {
    this._unsubscribeAuthState();
  }

  /**
   * Build an entity-aware mapper when schema is available.
   * Returns entity field names from `fromBackendRow` so `filterVisibleFields` can match them.
   */
  private createEntityMapper(
    schema?: dndevSchema<unknown>
  ): typeof defaultFieldMapper {
    const fieldNames = getEntityFieldNames(schema);
    if (fieldNames.length === 0) return this.mapper;
    return createEntityAwareMapper(fieldNames);
  }

  /**
   * Resolve the current user's role from the Supabase JWT app_metadata.
   * Result is cached for 30 seconds to avoid a getSession() call on every read/query.
   * Falls back to 'guest' when no session exists.
   */
  private async getUserRole(): Promise<UserRole> {
    if (this.requestRole) return this.requestRole;
    const now = Date.now();
    if (this._roleCache && now < this._roleCache.expiresAt) {
      return this._roleCache.role;
    }
    try {
      const { data } = await this.client.auth.getSession();
      const role = roleFromAppMetadata(
        !!data?.session,
        data?.session?.user?.app_metadata
      );
      this._roleCache = { role, expiresAt: now + 30_000 };
      return role;
    } catch {
      return 'guest';
    }
  }

  /**
   * Build a PostgREST select string from visible fields for the current role.
   * Always includes idColumn and status (needed for hidden-status logic).
   * Falls back to '*' if schema is unavailable or getVisibleFields returns empty.
   */
  private buildSelectColumns(
    collection: string,
    schema: dndevSchema<unknown> | undefined,
    role: UserRole
  ): string {
    if (!schema) return '*';
    try {
      const appFields = getVisibleFields(schema, role);
      if (appFields.length === 0) return '*';
      // Map app-level field names to backend column names
      const cols = new Set(appFields.map((f) => this.mapper.toBackendField(f)));
      // Always include id + status (required for framework logic)
      cols.add(this.idColumn);
      cols.add('status');
      const missing = this.missingTranslationColumns.get(collection);
      if (missing) for (const col of missing) cols.delete(col);
      return Array.from(cols).join(',');
    } catch {
      return '*';
    }
  }

  /**
   * True when `error` is Postgres 42703 (undefined column) on a translation column not
   * yet known missing: the column is recorded so the retried select leaves it out.
   * Any other error returns false and is thrown as usual.
   */
  private noteMissingTranslationColumn(
    collection: string,
    error: { code?: string; message?: string }
  ): boolean {
    if (error.code !== '42703') return false;
    const column = /column \S+?\.(\w+) does not exist/.exec(
      error.message ?? ''
    )?.[1];
    if (!column?.endsWith('_i18n')) return false;
    const missing = this.missingTranslationColumns.get(collection) ?? new Set();
    if (missing.has(column)) return false;
    missing.add(column);
    this.missingTranslationColumns.set(collection, missing);
    console.warn(
      `[SupabaseCrudAdapter] ${collection}.${column} does not exist: serving the default language for that field. Apply the migration that adds it.`
    );
    return true;
  }

  async get<T>(
    collection: string,
    id: string,
    schema?: dndevSchema<unknown>,
    options?: CrudOperationOptions
  ): Promise<T | null> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    const role: UserRole = schema ? await this.getUserRole() : 'guest';
    const selectCols = this.buildSelectColumns(collection, schema, role);

    const { data, error } = await this.asRequester(
      this.client.from(collection).select(selectCols)
    )
      .eq(this.idColumn, id)
      .maybeSingle();

    if (error) {
      if (this.noteMissingTranslationColumn(collection, error))
        return this.get<T>(collection, id, schema, options);
      // PGRST116 = no rows returned — not found, return null
      if (error.code === 'PGRST116' || error.message?.includes('No rows'))
        return null;
      throw wrapCrudError(error, 'SupabaseCrudAdapter', 'get', collection, id);
    }
    if (!data) return null;

    const record = v.parse(ROW_SCHEMA, data);
    // Use the actual DB id value, not the caller-supplied parameter, to prevent stale ID injection.
    const docId = String(record[this.idColumn] ?? id);
    const row = { ...record, id: docId };
    // Normalize with entity-aware mapper so keys match schema entries, then filter.
    const entityMapper = this.createEntityMapper(schema);
    const normalized = entityMapper.fromBackendRow(row);
    if (schema) {
      const filtered = filterVisibleFields(normalized, schema, role);
      return asEntity<T>({ ...filtered, id: docId });
    }
    return asEntity<T>({ ...normalized, id: docId });
  }

  async add<T>(
    collection: string,
    data: T,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<{ id: string; data: Record<string, unknown> }> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    const validated = schema
      ? validateWithSchema(schema, data, 'SupabaseCrudAdapter.add')
      : data;
    const payload = stripTimestampFields(entityRecord(validated));

    // Require authenticated session for writes — same as Firebase; avoids orphaned rows and RLS bypass.
    let userId: string | undefined;
    try {
      const { data: sessionData } = await this.client.auth.getSession();
      userId = sessionData?.session?.user?.id;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseCrudAdapter',
        'add',
        collection
      );
    }
    if (!userId) {
      throw wrapCrudError(
        new Error('Authentication required for this operation'),
        'SupabaseCrudAdapter',
        'add',
        collection
      );
    }
    const payloadWithMeta = {
      ...payload,
      createdById: userId,
      updatedById: userId,
    };
    const insertPayload = this.mapper.toBackendKeys(payloadWithMeta);

    const { data: inserted, error } = await this.client
      .from(collection)
      .insert(insertPayload)
      .select()
      .single();

    if (error)
      throw wrapCrudError(error, 'SupabaseCrudAdapter', 'add', collection);
    if (!inserted)
      throw wrapCrudError(
        new Error('Insert returned no data'),
        'SupabaseCrudAdapter',
        'add',
        collection
      );

    const insertedRow = v.parse(ROW_SCHEMA, inserted);
    const id = String(insertedRow[this.idColumn] ?? '');
    const out = this.mapper.fromBackendRow({ ...insertedRow, id });
    return { id, data: out };
  }

  async set<T>(
    collection: string,
    id: string,
    data: T,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    const validated = schema
      ? validateWithSchema(schema, data, 'SupabaseCrudAdapter.set')
      : data;
    // Require authenticated session for writes — same as Firebase.
    let userId: string | undefined;
    try {
      const { data: sessionData } = await this.client.auth.getSession();
      userId = sessionData?.session?.user?.id;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseCrudAdapter',
        'set',
        collection,
        id
      );
    }
    if (!userId) {
      throw wrapCrudError(
        new Error('Authentication required for this operation'),
        'SupabaseCrudAdapter',
        'set',
        collection,
        id
      );
    }
    const payload = stripTimestampFields({
      ...entityRecord(validated),
      [this.idColumn]: id,
      updatedById: userId,
    });
    const { data: upserted, error } = await this.client
      .from(collection)
      .upsert(this.mapper.toBackendKeys(payload), {
        onConflict: this.idColumn,
      })
      .select(this.idColumn);

    if (error)
      throw wrapCrudError(error, 'SupabaseCrudAdapter', 'set', collection, id);

    if (!upserted || upserted.length === 0) {
      throw wrapCrudError(
        new Error('Upsert affected 0 rows: access denied'),
        'SupabaseCrudAdapter',
        'set',
        collection,
        id
      );
    }
  }

  async update<T>(
    collection: string,
    id: string,
    data: Partial<T>,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    // Require authenticated session for writes — same security boundary as add() and set().
    let userId: string | undefined;
    try {
      const { data: sessionData } = await this.client.auth.getSession();
      userId = sessionData?.session?.user?.id;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseCrudAdapter',
        'update',
        collection,
        id
      );
    }
    if (!userId) {
      throw wrapCrudError(
        new Error('Authentication required for this operation'),
        'SupabaseCrudAdapter',
        'update',
        collection,
        id
      );
    }

    const payload = stripTimestampFields({
      ...entityRecord(data),
      updatedById: userId,
    });
    const { data: updated, error } = await this.client
      .from(collection)
      .update(this.mapper.toBackendKeys(payload))
      .eq(this.idColumn, id)
      .select(this.idColumn);

    if (error)
      throw wrapCrudError(
        error,
        'SupabaseCrudAdapter',
        'update',
        collection,
        id
      );

    if (!updated || updated.length === 0) {
      throw wrapCrudError(
        new Error('Update affected 0 rows: entity not found or access denied'),
        'SupabaseCrudAdapter',
        'update',
        collection,
        id
      );
    }
  }

  async delete(
    collection: string,
    id: string,
    options?: CrudOperationOptions
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    // Require authenticated session for writes — same security boundary as add(), set(), and update().
    let userId: string | undefined;
    try {
      const { data: sessionData } = await this.client.auth.getSession();
      userId = sessionData?.session?.user?.id;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseCrudAdapter',
        'delete',
        collection,
        id
      );
    }
    if (!userId) {
      throw wrapCrudError(
        new Error('Authentication required for this operation'),
        'SupabaseCrudAdapter',
        'delete',
        collection,
        id
      );
    }

    const { data: deleted, error } = await this.client
      .from(collection)
      .delete()
      .eq(this.idColumn, id)
      .select(this.idColumn);

    if (error)
      throw wrapCrudError(
        error,
        'SupabaseCrudAdapter',
        'delete',
        collection,
        id
      );

    if (!deleted || deleted.length === 0) {
      throw wrapCrudError(
        new Error('Delete affected 0 rows: entity not found or access denied'),
        'SupabaseCrudAdapter',
        'delete',
        collection,
        id
      );
    }
  }

  /**
   * Bulk write on one collection: direct PostgREST calls under RLS, the same path
   * as {@link add} / {@link update} / {@link delete} (no edge function).
   *
   * Partial success: rows that are written stay written; rows that are not are
   * returned in `failed` with the reason. Requests:
   * - inserts: one array insert per chunk (a chunk is one statement, it succeeds
   *   or fails as a whole); a row failing schema validation fails alone;
   * - updates: grouped by identical patch, one `.update(patch).in(id, ids)` per
   *   group chunk (the bulk-bar case of one value on N rows is one request);
   * - deletes: one `.delete().in(id, ids)` per chunk.
   * Rows RLS skips or that do not exist are not returned by the write and are
   * reported failed ("affected 0 rows"), like `update()` / `delete()`.
   * Requests run with bounded concurrency.
   *
   * Field mapping (camelCase → snake_case), timestamp stripping and
   * `createdById` / `updatedById` stamping match the single-row methods.
   *
   * @throws {BulkCollisionError} an id in two buckets — before any network call.
   * @throws {DoNotDevError} no authenticated session (nothing attempted).
   *
   * @example
   * ```typescript
   * const r = await adapter.bulk<Product>('products', {
   *   updates: [{ id: 'p1', patch: { size: '50 ml' } }, { id: 'p2', patch: { size: '50 ml' } }],
   *   deletes: ['p3'],
   * });
   * r.updatedIds; // ['p1', 'p2']
   * r.failed;     // [{ op: 'delete', id: 'p3', error: 'Delete affected 0 rows: …' }]
   * ```
   */
  async bulk<T extends Record<string, unknown>>(
    collection: string,
    ops: BulkOperations<T>,
    schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<BulkResult> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    // 1. Collision detection before any I/O; BulkCollisionError re-thrown unwrapped.
    const collision = detectBulkCollisions(ops);
    if (collision.where !== null) {
      throw new BulkCollisionError(collision.collisions, collision.where);
    }

    const inserts = ops.inserts ?? [];
    const updates = ops.updates ?? [];
    const deletes = ops.deletes ?? [];

    // 2. Empty short-circuit — no network call.
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
      return { insertedIds: [], updatedIds: [], deletedIds: [], failed: [] };
    }

    // 3. Same security boundary as the single-row writes: a session is required.
    const userId = await this.requireSessionUserId('bulk', collection);

    const failed: BulkFailure[] = [];
    const tasks: Array<() => Promise<void>> = [];

    // 4. Inserts — validate per row, then one array insert per chunk.
    const insertRows: Array<{ index: number; row: Record<string, unknown> }> = [];
    inserts.forEach((row, index) => {
      try {
        const validated = schema
          ? validateWithSchema(schema, row, 'SupabaseCrudAdapter.bulk')
          : row;
        insertRows.push({
          index,
          row: this.mapper.toBackendKeys({
            ...stripTimestampFields(validated),
            createdById: userId,
            updatedById: userId,
          }),
        });
      } catch (err) {
        failed.push({ op: 'insert', index, error: errorMessage(err) });
      }
    });
    const insertedByIndex = new Map<number, string>();
    for (const chunk of chunked(insertRows, BULK_CHUNK_SIZE)) {
      tasks.push(async () => {
        const { data, error } = await this.client
          .from(collection)
          .insert(chunk.map((c) => c.row))
          .select(this.idColumn)
          .then(
            (res) => res,
            (thrown: unknown) => ({ data: null, error: thrown })
          );
        const ids = this.returnedIds(data);
        if (error || ids.length !== chunk.length) {
          const reason = error
            ? errorMessage(error)
            : 'Insert returned no data: access denied';
          chunk.forEach((c) =>
            failed.push({ op: 'insert', index: c.index, error: reason })
          );
          return;
        }
        // PostgREST returns inserted rows in input order
        chunk.forEach((c, i) => insertedByIndex.set(c.index, ids[i]!));
      });
    }

    // 5. Updates — group ids by identical (mapped) patch.
    const groups = new Map<
      string,
      { patch: Record<string, unknown>; ids: string[] }
    >();
    for (const { id, patch } of updates) {
      const mapped = this.mapper.toBackendKeys(
        stripTimestampFields({
          ...patch,
          updatedById: userId,
        })
      );
      const key = JSON.stringify(mapped);
      const group = groups.get(key);
      if (group) group.ids.push(id);
      else groups.set(key, { patch: mapped, ids: [id] });
    }
    const updated = new Set<string>();
    for (const { patch, ids } of groups.values()) {
      for (const chunk of chunked(ids, BULK_CHUNK_SIZE)) {
        tasks.push(async () => {
          const { data, error } = await this.client
            .from(collection)
            .update(patch)
            .in(this.idColumn, chunk)
            .select(this.idColumn)
            .then(
              (res) => res,
              (thrown: unknown) => ({ data: null, error: thrown })
            );
          this.collectWritten('update', chunk, data, error, updated, failed);
        });
      }
    }

    // 6. Deletes.
    const deleted = new Set<string>();
    for (const chunk of chunked(deletes, BULK_CHUNK_SIZE)) {
      tasks.push(async () => {
        const { data, error } = await this.client
          .from(collection)
          .delete()
          .in(this.idColumn, chunk)
          .select(this.idColumn)
          .then(
            (res) => res,
            (thrown: unknown) => ({ data: null, error: thrown })
          );
        this.collectWritten('delete', chunk, data, error, deleted, failed);
      });
    }

    await runConcurrently(tasks, BULK_CONCURRENCY);

    return {
      insertedIds: inserts
        .map((_, index) => insertedByIndex.get(index))
        .filter((id): id is string => id !== undefined),
      updatedIds: updates.map((u) => u.id).filter((id) => updated.has(id)),
      deletedIds: deletes.filter((id) => deleted.has(id)),
      failed,
    };
  }

  /**
   * Record which ids an update/delete chunk actually wrote. Ids the write did not
   * return (RLS skipped them, or they do not exist) and ids of a failed request
   * are added to `failed`.
   */
  private collectWritten(
    op: 'update' | 'delete',
    ids: string[],
    data: unknown,
    error: unknown,
    written: Set<string>,
    failed: BulkFailure[]
  ): void {
    if (error) {
      const reason = errorMessage(error);
      ids.forEach((id) => failed.push({ op, id, error: reason }));
      return;
    }
    const returned = new Set(this.returnedIds(data));
    const label = op === 'update' ? 'Update' : 'Delete';
    for (const id of ids) {
      if (returned.has(id)) written.add(id);
      else
        failed.push({
          op,
          id,
          error: `${label} affected 0 rows: entity not found or access denied`,
        });
    }
  }

  /** Ids of the rows a write returned (`.select(idColumn)`), in returned order. */
  private returnedIds(data: unknown): string[] {
    // Validated, not cast: a malformed PostgREST response fails loud
    const rows = v.parse(RETURNED_ROWS_SCHEMA, data) ?? [];
    return rows.map((row) => String(v.parse(ROW_ID_SCHEMA, row[this.idColumn])));
  }

  /** Authenticated user id, or a wrapped error (no session: nothing is written). */
  private async requireSessionUserId(
    operation: string,
    collection: string
  ): Promise<string> {
    let userId: string | undefined;
    try {
      const { data: sessionData } = await this.client.auth.getSession();
      userId = sessionData?.session?.user?.id;
    } catch (err) {
      throw wrapCrudError(
        err instanceof Error ? err : new Error(String(err)),
        'SupabaseCrudAdapter',
        operation,
        collection
      );
    }
    if (!userId) {
      throw wrapCrudError(
        new Error('Authentication required for this operation'),
        'SupabaseCrudAdapter',
        operation,
        collection
      );
    }
    return userId;
  }

  async query<T>(
    collection: string,
    options: QueryOptions,
    schema?: dndevSchema<unknown>,
    _schemaType?: 'list' | 'listCard',
    operationOptions?: CrudOperationOptions
  ): Promise<PaginatedQueryResult<T>> {
    if (operationOptions?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }
    const queryRole = schema ? await this.getUserRole() : null;
    const selectCols =
      schema && queryRole
        ? this.buildSelectColumns(collection, schema, queryRole)
        : '*';

    let q = toFilterBuilder(
      this.asRequester(
        this.client.from(collection).select(selectCols, { count: 'exact' })
      )
    );

    const toBackendField = (appField: string) =>
      this.mapper.toBackendField(appField);
    if (options.where) {
      for (const clause of options.where) {
        q = applyWhere(q, clause, toBackendField);
      }
    }

    const firstOrder = options.orderBy?.[0];
    const orderFieldApp = ensureStringField(
      firstOrder?.field ?? this.idColumn,
      'orderBy'
    );
    const orderFieldBackend = toBackendField(orderFieldApp);
    const orderDirection = firstOrder?.direction ?? 'asc';
    if (options.orderBy && options.orderBy.length > 0) {
      for (const ob of options.orderBy) {
        const col = toBackendField(ensureStringField(ob.field, 'orderBy'));
        q = q.order(col, { ascending: (ob.direction ?? 'asc') === 'asc' });
      }
    } else {
      q = q.order(this.idColumn, { ascending: true });
    }

    const limit = options.limit ?? 1000;
    const cursor = options.startAfter ?? null;

    // When using cursor pagination, the count from the main query only reflects rows
    // after/before the cursor. Run a separate count query (without cursor filter) for
    // the true total count.
    let totalCount: number | undefined;
    if (cursor) {
      // Separate count query: same where/order filters but NO cursor filter
      let countQ = toFilterBuilder(
        this.asRequester(
          this.client.from(collection).select(selectCols, {
            count: 'exact',
            head: true,
          })
        )
      );
      if (options.where) {
        for (const clause of options.where) {
          countQ = applyWhere(countQ, clause, toBackendField);
        }
      }
      const { count: totalFromCount } = await countQ;
      totalCount = totalFromCount ?? undefined;

      if (orderDirection === 'asc') {
        q = q.gt(orderFieldBackend, cursor);
      } else {
        q = q.lt(orderFieldBackend, cursor);
      }
    }

    q = q.limit(limit + 1);

    const { data, error, count } = await q;

    if (error) {
      if (this.noteMissingTranslationColumn(collection, error))
        return this.query<T>(
          collection,
          options,
          schema,
          _schemaType,
          operationOptions
        );
      const message =
        typeof error === 'object' && 'message' in error ? error.message : '';
      throw wrapCrudError(
        error instanceof Error
          ? error
          : new Error((typeof message === 'string' && message) || String(error)),
        'SupabaseCrudAdapter',
        'query',
        collection
      );
    }

    const rows = v.parse(QUERY_ROWS_SCHEMA, data) ?? [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = items[items.length - 1];
    const lastVisible =
      lastRow != null
        ? String(
            lastRow[orderFieldBackend] ??
              lastRow[this.idColumn] ??
              lastRow.id ??
              ''
          )
        : null;

    const role = queryRole;
    const entityMapper = this.createEntityMapper(schema);
    const resultItems: T[] = [];
    for (const row of items) {
      // Derive docId from the raw row before normalization to avoid id loss
      // when idColumn differs from 'id' (e.g. 'userId' normalized to 'userId').
      const docId = String(row[this.idColumn] ?? row.id ?? '');
      const withId = { ...row, id: docId };
      // Normalize with entity-aware mapper so keys match schema entries, then filter.
      const normalized = entityMapper.fromBackendRow(withId);
      const filtered =
        schema && role
          ? filterVisibleFields(normalized, schema, role)
          : normalized;
      resultItems.push(asEntity<T>({ ...filtered, id: docId }));
    }

    return {
      items: resultItems,
      total: totalCount ?? count ?? undefined,
      hasMore,
      lastVisible,
    };
  }

  subscribe?<T>(
    collection: string,
    id: string,
    callback: DocumentSubscriptionCallback<T>,
    schema?: dndevSchema<unknown>
  ): () => void {
    // Encode collection and id so colons and other special chars don't produce ambiguous
    // or colliding channel names (e.g. collection="user:data", id="a:b" → "doc:user:data:a:b"
    // is indistinguishable from collection="user", id="data:a:b").
    const channel = this.client.channel(
      `doc:${encodeURIComponent(collection)}:${encodeURIComponent(id)}`
    );
    // Create mapper once (schema doesn't change during subscription lifetime).
    const entityMapper = this.createEntityMapper(schema);

    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: collection,
          filter: `${this.idColumn}=eq.${sanitizePostgrestFilterValue(id)}`,
        },
        (payload: {
          new?: Record<string, unknown>;
          old?: Record<string, unknown>;
        }) => {
          const row = payload.new;
          if (!row) {
            // Document deleted
            callback(null);
            return;
          }
          const withId = { ...row, id: row[this.idColumn] ?? id };
          if (schema) {
            this.getUserRole().then(
              (role) => {
                const normalized = entityMapper.fromBackendRow(withId);
                const filtered = filterVisibleFields(normalized, schema, role);
                callback(asEntity<T>({ ...filtered, id }));
              },
              () => {
                const normalized = entityMapper.fromBackendRow(withId);
                const filtered = filterVisibleFields(
                  normalized,
                  schema,
                  'guest'
                );
                callback(asEntity<T>({ ...filtered, id }));
              }
            );
          } else {
            const normalized = entityMapper.fromBackendRow(withId);
            callback(asEntity<T>({ ...normalized, id }));
          }
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          callback(
            null,
            wrapCrudError(
              new Error(`Subscription error: ${status}`),
              'SupabaseCrudAdapter',
              'subscribe',
              collection,
              id
            )
          );
        }
      });

    return () => {
      this.client.removeChannel(channel);
    };
  }

  subscribeToCollection?<T>(
    collection: string,
    options: QueryOptions,
    callback: CollectionSubscriptionCallback<T>,
    schema?: dndevSchema<unknown>
  ): () => void {
    // Translate equality where clauses into a Supabase channel filter.
    // This prevents cross-tenant notifications in scoped (multi-tenant) apps.
    // Non-equality operators are skipped — they are applied server-side in the re-fetch.
    //
    // IMPORTANT: Two separate representations are derived from the equality clauses:
    //
    // 1. `postgrestFilter` — raw (unencoded) values for the actual PostgREST channel filter.
    //    PostgREST filter syntax is NOT URL-encoded: `field=eq.value` with literal characters.
    //    Passing percent-encoded values here would cause filters to never match.
    //
    // 2. `channelName` — uses percent-encoded values so special chars (colons, ampersands,
    //    spaces) in field values cannot produce ambiguous or colliding channel identifiers.
    const equalityWhereClauses = (options.where ?? []).filter(
      (c) => c.operator === CRUD_OPERATORS.EQ && c.value != null
    );
    const toBackendField = (appField: string) =>
      this.mapper.toBackendField(appField);

    // WARNING: Supabase Realtime only supports a SINGLE filter per channel subscription.
    // When multiple equality clauses are passed, only the first is used as the realtime filter.
    // The full query (with all filters) is still applied when re-fetching data on change events.
    if (equalityWhereClauses.length > 1) {
      console.warn(
        `[SupabaseCrudAdapter] subscribeToCollection("${collection}"): ${equalityWhereClauses.length} equality filters provided, ` +
          'but Supabase Realtime only supports one filter per channel. Only the first filter will be used for realtime; ' +
          'all filters are applied when re-querying. You may receive extra change notifications that are filtered out on re-fetch.'
      );
    }

    // Raw PostgREST filter — used as the actual Supabase realtime filter (backend column names)
    // Only the first filter is passed to the channel (Supabase Realtime limitation).
    const firstClause = equalityWhereClauses[0];
    const postgrestFilter = firstClause
      ? `${toBackendField(ensureStringField(firstClause.field, 'subscribeToCollection.where'))}=eq.${sanitizePostgrestFilterValue(String(firstClause.value))}`
      : undefined;

    // Encoded filter — used only to build a collision-safe channel name
    const encodedFilterForName =
      equalityWhereClauses.length > 0
        ? equalityWhereClauses
            .map(
              (c) =>
                `${toBackendField(ensureStringField(c.field, 'subscribeToCollection.where'))}=eq.${encodeURIComponent(String(c.value))}`
            )
            .join('&')
        : undefined;

    // Encode the collection name itself to prevent colon-based ambiguity in channel names.
    const channelName = encodedFilterForName
      ? `col:${encodeURIComponent(collection)}:${encodedFilterForName}`
      : `col:${encodeURIComponent(collection)}`;
    const channel = this.client.channel(channelName);

    // Debounce re-queries: rapid table writes (burst INSERT/UPDATE/DELETE) coalesce into one fetch.
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const debouncedQuery = (): void => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        this.query<T>(collection, options, schema).then(
          (r) => callback(r.items),
          (err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            callback(
              [],
              wrapCrudError(
                error,
                'SupabaseCrudAdapter',
                'subscribeToCollection',
                collection
              )
            );
          }
        );
      }, 100);
    };

    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: collection,
          // Use raw (unencoded) PostgREST filter — NOT the encoded channel-name version.
          ...(postgrestFilter ? { filter: postgrestFilter } : {}),
        },
        debouncedQuery
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          callback(
            [],
            wrapCrudError(
              new Error(`Subscription error: ${status}`),
              'SupabaseCrudAdapter',
              'subscribeToCollection',
              collection
            )
          );
        }
      });

    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      this.client.removeChannel(channel);
    };
  }
}
