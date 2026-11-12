// packages/providers/supabase/src/client/callableProvider.ts

/**
 * @fileoverview Supabase Callable Provider
 * @description ICallableProvider implementation using Supabase Edge Functions.
 * Auth token is automatically passed by the Supabase client SDK.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { ICallableProvider } from '@donotdev/core';
import { wrapCrudError, DoNotDevError } from '@donotdev/core';

// =============================================================================
// Helpers
// =============================================================================

/**
 * Body of a non-2xx Edge Function response, `{ error, code? }` as written by the
 * framework handlers (e.g. a `createDeleteAccount` `beforeDelete` refusal).
 * `FunctionsHttpError.context` is the raw `Response`; its body is still unread.
 * Returns null when the error carries no JSON body with a string `error`.
 */
async function readServerError(
  error: unknown
): Promise<{ serverMessage: string; serverCode?: string } | null> {
  const response =
    typeof error === 'object' && error !== null && 'context' in error
      ? error.context
      : undefined;
  if (!(response instanceof Response)) return null;
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (typeof body !== 'object' || body === null) return null;
  const { error: message, code } = body as { error?: unknown; code?: unknown };
  if (typeof message !== 'string') return null;
  return typeof code === 'string'
    ? { serverMessage: message, serverCode: code }
    : { serverMessage: message };
}

// =============================================================================
// SupabaseCallableProvider
// =============================================================================

/**
 * Invokes Supabase Edge Functions via the client SDK.
 * The Supabase client automatically includes the user's auth token.
 *
 * CRUD operations (get_*, create_*, update_*, delete_*, list_*, listCard_*) are automatically
 * routed to a single `crud` Edge Function with `_functionName` in the body for dispatch.
 *
 * **Important:** If you have custom Edge Functions whose names start with `get_`, `list_`,
 * `create_`, `update_`, `delete_`, or `listCard_`, pass `crudCollections` to restrict
 * auto-routing to only those explicit collection names. Without it, any function matching
 * the prefix pattern is silently rerouted to the `crud` dispatcher.
 *
 * @example
 * ```typescript
 * import { configureProviders } from '@donotdev/core';
 * import { SupabaseCallableProvider } from '@donotdev/supabase';
 *
 * // Safe: only 'users' and 'products' collections route through the crud dispatcher
 * configureProviders({
 *   callable: new SupabaseCallableProvider(supabaseClient, {
 *     crudCollections: ['users', 'products'],
 *   }),
 * });
 *
 * // Without crudCollections: any get_*, list_*, etc. is auto-routed (may conflict with custom functions)
 * configureProviders({
 *   callable: new SupabaseCallableProvider(supabaseClient),
 * });
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export class SupabaseCallableProvider implements ICallableProvider {
  private readonly crudFunctionName: string;
  private readonly crudCollections: Set<string> | null;

  private static readonly CRUD_OP_REGEX =
    /^(get|create|update|delete|list|listCard)_(.+)$/;

  constructor(
    private readonly client: SupabaseClient,
    options?: {
      crudFunctionName?: string;
      /**
       * Explicit list of collection names that route through crudFunctionName.
       * When provided, only operations for these exact collections are auto-routed.
       * When omitted, any function matching the CRUD naming pattern is auto-routed.
       * Provide this to prevent misrouting of custom functions like get_summary, list_report, etc.
       */
      crudCollections?: string[];
    }
  ) {
    this.crudFunctionName = options?.crudFunctionName ?? 'crud';
    this.crudCollections = options?.crudCollections
      ? new Set(options.crudCollections)
      : null;
  }

  async call<TReq, TRes>(functionName: string, data: TReq): Promise<TRes> {
    try {
      // Detect CRUD operations by naming convention.
      // If crudCollections is set, only route those explicit collections — prevents
      // misrouting of user-defined functions that happen to match the prefix pattern.
      const match = SupabaseCallableProvider.CRUD_OP_REGEX.exec(functionName);
      // match[2] is always a non-empty string when match is non-null (group 2 is required in the regex)
      const isCrudOp =
        match !== null &&
        (this.crudCollections === null || this.crudCollections.has(match[2]!));
      const targetFunction = isCrudOp ? this.crudFunctionName : functionName;

      // For CRUD ops, add _functionName to body for dispatch routing
      // why: CallableProvider's TReq is unconstrained; callable payloads are JSON objects by contract
      const body = isCrudOp
        ? { _functionName: functionName, ...(data as Record<string, unknown>) }
        : (data as Record<string, unknown>);

      const { data: result, error } = await this.client.functions.invoke(
        targetFunction,
        {
          body,
        }
      );

      if (error) {
        const wrapped = wrapCrudError(
          error instanceof Error ? error : new Error(String(error)),
          'SupabaseCallableProvider',
          'call',
          functionName
        );
        const server = await readServerError(error);
        if (!server) throw wrapped;
        throw new DoNotDevError(wrapped.message, wrapped.code, {
          source: wrapped.source,
          details: { ...wrapped.details, ...server },
        });
      }

      // why: CallableProvider's TRes is caller-asserted; the function's response has no schema here
      return result as TRes;
    } catch (error) {
      if (error instanceof DoNotDevError) throw error;
      throw wrapCrudError(
        error instanceof Error ? error : new Error(String(error)),
        'SupabaseCallableProvider',
        'call',
        functionName
      );
    }
  }
}
