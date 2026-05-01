// packages/providers/supabase/src/__tests__/crudContract.test.ts

/**
 * @fileoverview Contract tests for Supabase CRUD Adapter (ICrudAdapter)
 * @description Verifies SupabaseCrudAdapter satisfies ICrudAdapter with a mocked client.
 * No network calls — mocks only.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { ICrudAdapter } from '@donotdev/core';

import { SupabaseCrudAdapter } from '../client/crudAdapter';

// =============================================================================
// Mock Supabase client (PostgREST / channel stubs)
// =============================================================================

function createChainableQueryMock(result: { data: unknown[]; count?: number }) {
  const chain = {
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    contains: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    then: vi.fn((onfulfilled?: (v: unknown) => unknown) =>
      Promise.resolve({
        data: result.data,
        error: null,
        count: result.count,
      }).then(onfulfilled)
    ),
  };
  return chain;
}

function createMockSupabaseClient(overrides?: {
  getData?: Record<string, unknown> | null;
  getError?: Error | null;
  insertData?: Record<string, unknown>;
  singleError?: Error | null;
  queryResult?: { data: unknown[]; count?: number };
}) {
  const getData = overrides?.getData ?? null;
  const getError = overrides?.getError ?? null;
  const insertData = overrides?.insertData ?? { id: 'mock-id', name: 'Test' };
  const singleError = overrides?.singleError ?? null;
  const queryResult = overrides?.queryResult ?? { data: [], count: 0 };

  const from = vi.fn().mockImplementation((_collection: string) => {
    return {
      select: vi
        .fn()
        .mockImplementation((_cols?: string, opts?: { count?: string }) => {
          if (opts?.count === 'exact') {
            return createChainableQueryMock(queryResult);
          }
          return {
            eq: vi.fn().mockReturnValue({
              maybeSingle: vi.fn().mockResolvedValue({
                data: getData,
                error: getError,
              }),
            }),
          };
        }),
      insert: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          single: vi.fn().mockResolvedValue({
            data: insertData,
            error: singleError,
          }),
        }),
      }),
      upsert: vi.fn().mockReturnValue({
        select: vi
          .fn()
          .mockResolvedValue({ data: [{ id: 'u1' }], error: null }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue({ data: [{ id: 'u1' }], error: null }),
        }),
      }),
      delete: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi
            .fn()
            .mockResolvedValue({ data: [{ id: 'u1' }], error: null }),
        }),
      }),
    };
  });

  const channel = vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn(),
  });
  const removeChannel = vi.fn();

  const auth = {
    getSession: vi.fn().mockResolvedValue({
      data: {
        session: {
          user: { id: 'mock-user-id', app_metadata: { role: 'user' } },
        },
      },
      error: null,
    }),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } },
    })),
  };

  return {
    from,
    channel,
    removeChannel,
    auth,
  } as unknown as import('@supabase/supabase-js').SupabaseClient;
}

// =============================================================================
// Contract tests
// =============================================================================

describe('SupabaseCrudAdapter — ICrudAdapter contract', () => {
  let client: ReturnType<typeof createMockSupabaseClient>;
  let adapter: SupabaseCrudAdapter;

  beforeEach(() => {
    client = createMockSupabaseClient();
    adapter = new SupabaseCrudAdapter(client);
  });

  it('satisfies ICrudAdapter type', () => {
    const typed: ICrudAdapter = adapter;
    expect(typed).toBeDefined();
    expect(typeof typed.get).toBe('function');
    expect(typeof typed.add).toBe('function');
    expect(typeof typed.set).toBe('function');
    expect(typeof typed.update).toBe('function');
    expect(typeof typed.delete).toBe('function');
    expect(typeof typed.query).toBe('function');
  });

  it('get() returns null when no document', async () => {
    const result = await adapter.get<{ name: string }>('users', 'missing');
    expect(result).toBeNull();
  });

  it('get() returns document when mock returns data', async () => {
    const mockClient = createMockSupabaseClient({
      getData: { id: 'u1', name: 'Alice', age: 30 },
    });
    const ad = new SupabaseCrudAdapter(mockClient);
    const result = await ad.get<{ id: string; name: string; age: number }>(
      'users',
      'u1'
    );
    expect(result).not.toBeNull();
    expect(result?.id).toBe('u1');
    expect(result?.name).toBe('Alice');
    expect(result?.age).toBe(30);
  });

  it('add() returns { id, data }', async () => {
    const result = await adapter.add<{ name: string }>('users', {
      name: 'Bob',
    });
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('data');
    expect(typeof result.id).toBe('string');
    expect(result.id.length).toBeGreaterThan(0);
    expect(result.data).toBeDefined();
  });

  it('set() resolves without error', async () => {
    await expect(
      adapter.set<{ name: string }>('users', 'u1', { name: 'Alice' })
    ).resolves.toBeUndefined();
    expect(client.from).toHaveBeenCalledWith('users');
  });

  it('update() resolves without error', async () => {
    await expect(
      adapter.update<{ name: string }>('users', 'u1', { name: 'Updated' })
    ).resolves.toBeUndefined();
  });

  it('delete() resolves without error', async () => {
    await expect(adapter.delete('users', 'u1')).resolves.toBeUndefined();
  });

  it('query() returns PaginatedQueryResult shape', async () => {
    const mockClient = createMockSupabaseClient({
      queryResult: {
        data: [
          { id: '1', name: 'A' },
          { id: '2', name: 'B' },
        ],
        count: 2,
      },
    });
    const ad = new SupabaseCrudAdapter(mockClient);
    const result = await ad.query<{ id: string; name: string }>('users', {});

    expect(Array.isArray(result.items)).toBe(true);
    expect(typeof result.hasMore).toBe('boolean');
    expect(result.total === undefined || typeof result.total === 'number').toBe(
      true
    );
    expect(
      result.lastVisible === null || typeof result.lastVisible === 'string'
    ).toBe(true);
  });

  it('add() throws when insert returns error', async () => {
    const failingClient = createMockSupabaseClient({
      singleError: new Error('insert failed'),
    });
    const ad = new SupabaseCrudAdapter(failingClient);
    await expect(ad.add('users', { name: 'X' })).rejects.toThrow(
      'insert failed'
    );
  });

  it('get() throws when backend returns non-not-found error', async () => {
    const clientWithError = createMockSupabaseClient({
      getData: null,
      getError: new Error('network error'),
    });
    const ad = new SupabaseCrudAdapter(clientWithError);
    await expect(ad.get<{ name: string }>('users', 'id1')).rejects.toThrow();
  });

  it('subscribe is defined (optional on ICrudAdapter)', () => {
    expect(typeof adapter.subscribe).toBe('function');
  });

  it('subscribeToCollection is defined (optional on ICrudAdapter)', () => {
    expect(typeof adapter.subscribeToCollection).toBe('function');
  });
});
