// packages/providers/supabase/src/client/crudAdapter.ts

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

import * as v from 'valibot';

import {
  BulkCollisionError,
  BulkRequestSchema,
  BulkResponseSchema,
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
  BulkOperations,
  BulkResult,
  ICrudAdapter,
  QueryOptions,
  QueryWhereClause,
  PaginatedQueryResult,
  DocumentSubscriptionCallback,
  CollectionSubscriptionCallback,
  CrudOperator,
  CrudOperationOptions,
  dndevSchema,
} from '@donotdev/core';
import type { UserRole } from '@donotdev/core';

import {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
} from '../common/fieldMapper';

import type { SupabaseClient } from '@supabase/supabase-js';

const DEFAULT_ID_COLUMN = 'id';

/** Strip timestamp fields so the DB sets them (DEFAULT now() / trigger). */
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
  switch (operator as CrudOperator) {
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
      return q.not(col, 'in', Array.isArray(value) ? value : [value]);
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
        `SupabaseCrudAdapter: unsupported operator "${operator as string}"`,
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
    const now = Date.now();
    if (this._roleCache && now < this._roleCache.expiresAt) {
      return this._roleCache.role;
    }
    try {
      const { data } = await this.client.auth.getSession();
      const meta = data?.session?.user?.app_metadata;
      // Default: authenticated session = 'user', no session = 'guest'
      const hasSession = !!data?.session;
      let role: UserRole = (hasSession ? 'user' : 'guest') as UserRole;
      if (meta) {
        if (meta.role === 'super' || meta.isSuper === true)
          role = 'super' as UserRole;
        else if (meta.role === 'admin' || meta.isAdmin === true)
          role = 'admin' as UserRole;
        else if (meta.role) role = meta.role as UserRole;
        // else: keep 'user' default for authenticated sessions without explicit role
      }
      this._roleCache = { role, expiresAt: now + 30_000 };
      return role;
    } catch {
      return 'guest' as UserRole;
    }
  }

  /**
   * Build a PostgREST select string from visible fields for the current role.
   * Always includes idColumn and status (needed for hidden-status logic).
   * Falls back to '*' if schema is unavailable or getVisibleFields returns empty.
   */
  private buildSelectColumns(
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
      return Array.from(cols).join(',');
    } catch {
      return '*';
    }
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
    const role = schema ? await this.getUserRole() : ('guest' as UserRole);
    const selectCols = this.buildSelectColumns(schema, role);

    const { data, error } = await this.client
      .from(collection)
      .select(selectCols)
      .eq(this.idColumn, id)
      .maybeSingle();

    if (error) {
      // PGRST116 = no rows returned — not found, return null
      if (error.code === 'PGRST116' || error.message?.includes('No rows'))
        return null;
      throw wrapCrudError(error, 'SupabaseCrudAdapter', 'get', collection, id);
    }
    if (!data) return null;

    const record = data as unknown as Record<string, unknown>;
    // Use the actual DB id value, not the caller-supplied parameter, to prevent stale ID injection.
    const docId = String(record[this.idColumn] ?? id);
    const row = { ...record, id: docId };
    // Normalize with entity-aware mapper so keys match schema entries, then filter.
    const entityMapper = this.createEntityMapper(schema);
    const normalized = entityMapper.fromBackendRow(row);
    if (schema) {
      const filtered = filterVisibleFields(
        normalized as Record<string, any>,
        schema,
        role
      );
      return { ...filtered, id: docId } as T;
    }
    return { ...normalized, id: docId } as T;
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
    const payload = stripTimestampFields(validated as Record<string, unknown>);

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

    const id = String(
      (inserted as Record<string, unknown>)[this.idColumn] ?? ''
    );
    const out = this.mapper.fromBackendRow({
      ...(inserted as Record<string, unknown>),
      id,
    });
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
      ...(validated as Record<string, unknown>),
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
      ...(data as Record<string, unknown>),
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
   * Atomic bulk operation across one collection. Inserts, updates and deletes
   * are dispatched in a single round-trip to the `crud` edge function, which
   * routes to the `bulk_${collection}` handler via `_functionName` and runs
   * all three buckets inside one Postgres transaction (`crud_bulk` RPC). Any
   * failure rolls back — the client observes all-or-nothing.
   *
   * Field-mapping (camelCase → snake_case) is applied at this boundary for
   * `inserts` rows and `updates[].patch` so the server receives backend-shaped
   * payloads. `deletes` are opaque ids and pass through unmapped. Response ids
   * are opaque strings and are returned as-is.
   *
   * @throws {BulkCollisionError} if an id appears in both `updates` and
   *   `deletes`, or in both `inserts` (when carrying an explicit id) and
   *   `updates`. Thrown before any network call — re-thrown unwrapped.
   * @throws {DoNotDevError} when the edge function rejects, the response
   *   shape fails {@link BulkResponseSchema}, or the request body fails
   *   {@link BulkRequestSchema}. Wrapped via {@link wrapCrudError}.
   *
   * @example
   * ```typescript
   * const result = await adapter.bulk<Event>('events', {
   *   inserts: [{ title: 'A' }, { title: 'B' }],
   *   updates: [{ id: 'e1', patch: { title: 'renamed' } }],
   *   deletes: ['e2', 'e3'],
   * });
   * result.insertedIds; // ['evt_…', 'evt_…']
   * result.updatedIds;  // ['e1']
   * result.deletedIds;  // ['e2', 'e3']
   * ```
   */
  async bulk<T extends Record<string, unknown>>(
    collection: string,
    ops: BulkOperations<T>,
    _schema?: dndevSchema<T>,
    options?: CrudOperationOptions
  ): Promise<BulkResult> {
    if (options?.signal?.aborted) {
      throw new Error('Operation cancelled');
    }

    // 1. Collision detection runs before any I/O so BulkCollisionError is
    //    raised unwrapped, independent of transport.
    const collision = detectBulkCollisions(
      ops as {
        inserts?: Array<{ id?: string; [k: string]: unknown }>;
        updates?: Array<{ id: string; patch: unknown }>;
        deletes?: string[];
      }
    );
    if (collision.where !== null) {
      throw new BulkCollisionError(collision.collisions, collision.where);
    }

    const inserts = ops.inserts ?? [];
    const updates = ops.updates ?? [];
    const deletes = ops.deletes ?? [];

    // 2. Empty short-circuit — no network call, no audit row.
    if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) {
      return { insertedIds: [], updatedIds: [], deletedIds: [] };
    }

    // 3. Field-mapping: app camelCase → backend snake_case on writes. Matches
    //    the boundary enforced by add()/update() via `mapper.toBackendKeys()`.
    //    Deletes are opaque ids and are not mapped.
    const mappedInserts = inserts.map((row) =>
      this.mapper.toBackendKeys(row as Record<string, unknown>)
    );
    const mappedUpdates = updates.map((u) => ({
      id: u.id,
      patch: this.mapper.toBackendKeys(u.patch as Record<string, unknown>),
    }));

    const body = {
      inserts: mappedInserts,
      updates: mappedUpdates,
      deletes,
    };

    // 4. Validate body shape before putting it on the wire. Fail loud on
    //    structural issues — no silent degradation.
    const parsedBody = v.safeParse(BulkRequestSchema, body);
    if (!parsedBody.success) {
      throw wrapCrudError(
        new Error(
          `SupabaseCrudAdapter.bulk: invalid request body — ${parsedBody.issues
            .map((i) => i.message)
            .join('; ')}`
        ),
        'SupabaseCrudAdapter',
        'bulk',
        collection
      );
    }

    // 5. Dispatch via the shared `crud` edge function using the same
    //    `_functionName` routing contract as add()/update() when they go
    //    through SupabaseCallableProvider. The server resolves
    //    `bulk_${collection}` from `registerCrudFunctions`.
    const { data: result, error } = await this.client.functions.invoke('crud', {
      body: {
        _functionName: `bulk_${collection}`,
        ...parsedBody.output,
      },
    });

    if (error) {
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'SupabaseCrudAdapter',
        'bulk',
        collection
      );
    }

    // 6. Validate response on the wire. Malformed shape → fail loud.
    const parsedResponse = v.safeParse(BulkResponseSchema, result);
    if (!parsedResponse.success) {
      throw wrapCrudError(
        new Error(
          `SupabaseCrudAdapter.bulk: malformed response — ${parsedResponse.issues
            .map((i) => i.message)
            .join('; ')}`
        ),
        'SupabaseCrudAdapter',
        'bulk',
        collection
      );
    }

    return parsedResponse.output;
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
      schema && queryRole ? this.buildSelectColumns(schema, queryRole) : '*';

    let q: SbFilterBuilder = this.client
      .from(collection)
      .select(selectCols, { count: 'exact' }) as unknown as SbFilterBuilder;

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
      let countQ: SbFilterBuilder = this.client
        .from(collection)
        .select(selectCols, {
          count: 'exact',
          head: true,
        }) as unknown as SbFilterBuilder;
      if (options.where) {
        for (const clause of options.where) {
          countQ = applyWhere(countQ, clause, toBackendField);
        }
      }
      const countResult = await countQ;
      const { count: totalFromCount } = countResult as { count?: number };
      totalCount = totalFromCount ?? undefined;

      if (orderDirection === 'asc') {
        q = q.gt(orderFieldBackend, cursor);
      } else {
        q = q.lt(orderFieldBackend, cursor);
      }
    }

    q = q.limit(limit + 1);

    const result = await q;
    const { data, error, count } = result as {
      data: Record<string, unknown>[] | null;
      error: { message?: string; code?: string; details?: string } | null;
      count?: number;
    };

    if (error) {
      throw wrapCrudError(
        error instanceof Error
          ? error
          : new Error(error.message || String(error)),
        'SupabaseCrudAdapter',
        'query',
        collection
      );
    }

    const rows = (data ?? []) as Record<string, unknown>[];
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
          ? filterVisibleFields(normalized as Record<string, any>, schema, role)
          : normalized;
      resultItems.push({ ...filtered, id: docId } as T);
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
                const filtered = filterVisibleFields(
                  normalized as Record<string, any>,
                  schema,
                  role
                );
                callback({ ...filtered, id } as T);
              },
              () => {
                const normalized = entityMapper.fromBackendRow(withId);
                const filtered = filterVisibleFields(
                  normalized as Record<string, any>,
                  schema,
                  'guest' as UserRole
                );
                callback({ ...filtered, id } as T);
              }
            );
          } else {
            const normalized = entityMapper.fromBackendRow(withId);
            callback({ ...normalized, id } as T);
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
