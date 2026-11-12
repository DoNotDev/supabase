// packages/providers/supabase/src/__tests__/missingTranslationColumns.test.ts

/**
 * @fileoverview Reads before the translation migration
 * @description A field defined with `i18n: true` selects its `<column>_i18n` companion.
 * When the table does not have that column yet, PostgREST answers 42703: the adapter
 * leaves the column out, retries, and serves the default-language row.
 */

import { describe, it, expect, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createSchemas, defineEntity } from '@donotdev/core';

import { SupabaseCrudAdapter } from '../common/crudAdapter';

const product = defineEntity({
  name: 'Product',
  collection: 'products',
  fields: {
    title: { name: 'title', label: 'Title', type: 'text', visibility: 'guest' },
    description: {
      name: 'description',
      label: 'Description',
      type: 'textarea',
      visibility: 'guest',
      i18n: true,
    },
  },
});
const getSchema = createSchemas(product).get;

const ROW = { id: 'p1', status: 'available', title: 'Crème', description: 'Texte' };

/** Fake PostgREST: errors 42703 on the first selected column the table lacks. */
function client(tableColumns: string[]) {
  const selects: string[] = [];
  const answer = (cols: string) => {
    const missing = cols.split(',').find((c) => !tableColumns.includes(c));
    return missing
      ? {
          data: null,
          error: { code: '42703', message: `column products.${missing} does not exist` },
          count: null,
        }
      : { data: [ROW], error: null, count: 1 };
  };
  const from = vi.fn(() => ({
    select: vi.fn((cols: string) => {
      selects.push(cols);
      const result = answer(cols);
      const chain = {
        eq: () => ({
          maybeSingle: async () => ({
            data: result.data?.[0] ?? null,
            error: result.error,
          }),
        }),
        order: () => chain,
        limit: () => chain,
        then: (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok),
      };
      return chain;
    }),
  }));
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: null }, error: null })),
    onAuthStateChange: vi.fn(() => ({
      data: { subscription: { unsubscribe: vi.fn() } },
    })),
  };
  return { selects, client: { from, auth } as unknown as SupabaseClient };
}

describe('SupabaseCrudAdapter — translation column not migrated yet', () => {
  it('get() serves the default-language row without the companion column', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = client(['id', 'status', 'title', 'description']);
    const adapter = new SupabaseCrudAdapter(fake.client);

    const doc = await adapter.get<Record<string, unknown>>('products', 'p1', getSchema);

    expect(doc).toMatchObject({ id: 'p1', description: 'Texte' });
    expect(fake.selects[0]).toContain('description_i18n');
    expect(fake.selects[1]).not.toContain('description_i18n');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('query() retries without the column and later reads skip it at once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = client(['id', 'status', 'title', 'description']);
    const adapter = new SupabaseCrudAdapter(fake.client);

    const first = await adapter.query('products', {}, getSchema);
    const second = await adapter.query('products', {}, getSchema);

    expect(first.items).toHaveLength(1);
    expect(second.items).toHaveLength(1);
    expect(fake.selects).toHaveLength(3);
    expect(fake.selects[2]).not.toContain('description_i18n');
    warn.mockRestore();
  });

  it('selects the companion column when the table has it', async () => {
    const fake = client(['id', 'status', 'title', 'description', 'description_i18n']);
    const adapter = new SupabaseCrudAdapter(fake.client);

    await adapter.get('products', 'p1', getSchema);

    expect(fake.selects).toHaveLength(1);
    expect(fake.selects[0]).toContain('description_i18n');
  });

  it('still throws other missing columns', async () => {
    const fake = client(['id', 'status', 'description', 'description_i18n']);
    const adapter = new SupabaseCrudAdapter(fake.client);

    await expect(adapter.get('products', 'p1', getSchema)).rejects.toThrow();
  });
});
