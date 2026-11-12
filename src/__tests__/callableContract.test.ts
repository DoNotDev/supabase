// packages/providers/supabase/src/__tests__/callableContract.test.ts

/**
 * @fileoverview Contract tests for SupabaseCallableProvider (ICallableProvider)
 * @description Verifies call() wiring, CRUD routing, error wrapping, and type contract.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ICallableProvider } from '@donotdev/core';
import { DoNotDevError } from '@donotdev/core';

import { SupabaseCallableProvider } from '../client/callableProvider';

// =============================================================================
// Mock Supabase client (functions.invoke only)
// =============================================================================

function createMockSupabaseClient(overrides?: {
  invokeResult?: { data: unknown; error: unknown };
}) {
  const defaultResult = { data: { ok: true }, error: null };
  const invoke = vi
    .fn()
    .mockResolvedValue(overrides?.invokeResult ?? defaultResult);

  return {
    functions: { invoke },
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('SupabaseCallableProvider — ICallableProvider contract', () => {
  let client: ReturnType<typeof createMockSupabaseClient>;
  let provider: SupabaseCallableProvider;

  beforeEach(() => {
    client = createMockSupabaseClient();
    provider = new SupabaseCallableProvider(client);
  });

  // ---- Type contract ----

  it('satisfies ICallableProvider', () => {
    const typed: ICallableProvider = provider;
    expect(typed).toBeDefined();
    expect(typeof typed.call).toBe('function');
  });

  // ---- Direct function calls (non-CRUD) ----

  it('call() invokes the correct edge function with body', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: { quoteCents: 500 }, error: null });

    const result = await provider.call<
      { projectId: string },
      { quoteCents: number }
    >('compute-quote', { projectId: 'p1' });

    expect(invoke).toHaveBeenCalledWith('compute-quote', {
      body: { projectId: 'p1' },
    });
    expect(result).toEqual({ quoteCents: 500 });
  });

  it('call() passes payload directly for non-CRUD functions', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({
      data: { url: 'https://checkout' },
      error: null,
    });

    await provider.call<{ quoteId: string }, { url: string }>(
      'create-addon-checkout',
      { quoteId: 'q1' }
    );

    // Should NOT add _functionName for non-CRUD function names
    expect(invoke).toHaveBeenCalledWith('create-addon-checkout', {
      body: { quoteId: 'q1' },
    });
  });

  it('call() returns typed result on success', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({
      data: { jobId: 'j1', bugCount: 3, roundsRemaining: 2 },
      error: null,
    });

    const result = await provider.call<
      { projectId: string },
      { jobId: string; bugCount: number; roundsRemaining: number }
    >('fix-trigger', { projectId: 'p1' });

    expect(result.jobId).toBe('j1');
    expect(result.bugCount).toBe(3);
    expect(result.roundsRemaining).toBe(2);
  });

  // ---- CRUD auto-routing ----

  it('routes CRUD operations to crud edge function (no crudCollections)', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: [{ id: '1' }], error: null });

    await provider.call('get_users', { id: '1' });

    expect(invoke).toHaveBeenCalledWith('crud', {
      body: { _functionName: 'get_users', id: '1' },
    });
  });

  it('routes list_ operations to crud', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: [], error: null });

    await provider.call('list_products', { limit: 10 });

    expect(invoke).toHaveBeenCalledWith('crud', {
      body: { _functionName: 'list_products', limit: 10 },
    });
  });

  it('routes listCard_ operations to crud', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: [], error: null });

    await provider.call('listCard_orders', {});

    expect(invoke).toHaveBeenCalledWith('crud', {
      body: { _functionName: 'listCard_orders' },
    });
  });

  // ---- crudCollections scoping ----

  it('respects crudCollections — routes matching collections', async () => {
    const scoped = new SupabaseCallableProvider(client, {
      crudCollections: ['users'],
    });
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: { id: '1' }, error: null });

    await scoped.call('get_users', { id: '1' });

    expect(invoke).toHaveBeenCalledWith('crud', {
      body: { _functionName: 'get_users', id: '1' },
    });
  });

  it('respects crudCollections — does NOT route non-matching collections', async () => {
    const scoped = new SupabaseCallableProvider(client, {
      crudCollections: ['users'],
    });
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: { summary: '...' }, error: null });

    await scoped.call('get_summary', { projectId: 'p1' });

    // Should call directly, not through crud dispatcher
    expect(invoke).toHaveBeenCalledWith('get_summary', {
      body: { projectId: 'p1' },
    });
  });

  // ---- Custom crudFunctionName ----

  it('uses custom crudFunctionName when provided', async () => {
    const custom = new SupabaseCallableProvider(client, {
      crudFunctionName: 'api-router',
    });
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: [], error: null });

    await custom.call('delete_users', { id: '1' });

    expect(invoke).toHaveBeenCalledWith('api-router', {
      body: { _functionName: 'delete_users', id: '1' },
    });
  });

  // ---- Error handling ----

  it('throws DoNotDevError when invoke returns error', async () => {
    const failClient = createMockSupabaseClient({
      invokeResult: { data: null, error: new Error('edge function crashed') },
    });
    const p = new SupabaseCallableProvider(failClient);

    await expect(p.call('compute-quote', { projectId: 'p1' })).rejects.toThrow(
      DoNotDevError
    );
  });

  it('throws DoNotDevError when invoke returns non-Error error', async () => {
    const failClient = createMockSupabaseClient({
      invokeResult: { data: null, error: 'string error' },
    });
    const p = new SupabaseCallableProvider(failClient);

    await expect(p.call('compute-quote', { projectId: 'p1' })).rejects.toThrow(
      DoNotDevError
    );
  });

  it('carries the non-2xx response body { error, code } in details', async () => {
    // FunctionsHttpError shape: message + context = the raw Response
    const httpError = Object.assign(
      new Error('Edge Function returned a non-2xx status code'),
      {
        context: new Response(
          JSON.stringify({ error: 'open_orders', code: 'P0001' }),
          { status: 409 }
        ),
      }
    );
    const p = new SupabaseCallableProvider(
      createMockSupabaseClient({ invokeResult: { data: null, error: httpError } })
    );

    const err = await p.call('delete-account', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoNotDevError);
    expect((err as DoNotDevError).message).toBe('Request failed.');
    expect((err as DoNotDevError).details).toMatchObject({
      serverMessage: 'open_orders',
      serverCode: 'P0001',
    });
  });

  it('adds no server details when the response body is not JSON', async () => {
    const httpError = Object.assign(new Error('non-2xx'), {
      context: new Response('<html>bad gateway</html>', { status: 502 }),
    });
    const p = new SupabaseCallableProvider(
      createMockSupabaseClient({ invokeResult: { data: null, error: httpError } })
    );

    const err = (await p
      .call('delete-account', {})
      .catch((e: unknown) => e)) as DoNotDevError;
    expect(err).toBeInstanceOf(DoNotDevError);
    expect(err.details?.serverMessage).toBeUndefined();
  });

  it('preserves DoNotDevError when re-thrown', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockRejectedValue(
      new DoNotDevError('already wrapped', {
        provider: 'test',
        operation: 'call',
      })
    );

    await expect(provider.call('fn', {})).rejects.toThrow(DoNotDevError);
  });

  it('wraps unexpected exceptions as DoNotDevError', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockRejectedValue(new TypeError('network failure'));

    await expect(provider.call('fn', {})).rejects.toThrow(DoNotDevError);
  });

  // ---- Edge cases ----

  it('handles void return (storeWaiver pattern)', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: null, error: null });

    // Should not throw — null data with no error is valid for void functions
    const result = await provider.call<{ projectId: string }, void>(
      'compute-quote',
      { projectId: 'p1', action: 'store-waiver' } as any
    );

    expect(result).toBeNull();
  });

  it('non-CRUD function names are not routed (e.g. nadia-triage)', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: { classification: 'bug' }, error: null });

    await provider.call('nadia-triage', { projectId: 'p1', message: 'broken' });

    // Hyphenated names don't match CRUD regex — called directly
    expect(invoke).toHaveBeenCalledWith('nadia-triage', {
      body: { projectId: 'p1', message: 'broken' },
    });
  });

  it('function names used in getProjectApi are not misrouted as CRUD', async () => {
    const invoke = vi.mocked(client.functions.invoke);
    invoke.mockResolvedValue({ data: {}, error: null });

    const edgeFunctions = [
      'compute-quote',
      'nadia-triage',
      'fix-trigger',
      'addon-scope',
      'addon-quote',
      'create-addon-checkout',
      'create-spec-deposit-checkout',
      'save-supabase-token',
      'github-app-setup',
      'create-project',
    ];

    for (const fn of edgeFunctions) {
      invoke.mockClear();
      await provider.call(fn, {});
      // All should be called directly (not routed through 'crud')
      expect(invoke).toHaveBeenCalledWith(fn, { body: {} });
    }
  });
});
