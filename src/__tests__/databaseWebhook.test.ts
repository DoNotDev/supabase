// packages/providers/supabase/src/__tests__/databaseWebhook.test.ts

import { describe, expect, it } from 'vitest';

import { readDatabaseWebhook } from '../server/databaseWebhook';

describe('readDatabaseWebhook', () => {
  it('reads INSERT / UPDATE / DELETE with app field names', () => {
    expect(
      readDatabaseWebhook({
        type: 'INSERT',
        table: 'products',
        schema: 'public',
        record: { id: 'p1', product_slug: 'creme' },
        old_record: null,
      })
    ).toEqual({
      type: 'INSERT',
      table: 'products',
      schema: 'public',
      record: { id: 'p1', productSlug: 'creme' },
      oldRecord: null,
    });
    expect(
      readDatabaseWebhook({
        type: 'UPDATE',
        table: 'brands',
        schema: 'public',
        record: { slug: 'new' },
        old_record: { slug: 'old' },
      })
    ).toMatchObject({ record: { slug: 'new' }, oldRecord: { slug: 'old' } });
    expect(
      readDatabaseWebhook({
        type: 'DELETE',
        table: 'brands',
        schema: 'public',
        record: null,
        old_record: { slug: 'gone' },
      })
    ).toMatchObject({ record: null, oldRecord: { slug: 'gone' } });
  });

  it('refuses anything else, naming what is wrong', () => {
    expect(() => readDatabaseWebhook(null)).toThrow(/Not a Supabase database webhook row event/);
    expect(() =>
      readDatabaseWebhook({ type: 'TRUNCATE', table: 'x', schema: 'public', record: null, old_record: null })
    ).toThrow(/type/);
    expect(() =>
      readDatabaseWebhook({ type: 'UPDATE', table: 'x', schema: 'public', record: { a: 1 }, old_record: null })
    ).toThrow(/old_record/);
  });
});
