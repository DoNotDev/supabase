// packages/providers/supabase/src/__tests__/checkViolation.test.ts

/**
 * @fileoverview Postgres 23514 violations of generated CHECK constraints
 * @description `<table>_<column>_<rule>` maps back to the entity field and the
 * i18n key of the client message; other errors keep the generic wrapping.
 */

import { describe, it, expect, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { createSchemas, DoNotDevError } from '@donotdev/core';

import {
  checkConstraintName,
  CHECK_RULES,
  mapCheckViolation,
  parseCheckConstraintName,
} from '../common/checkConstraints';
import { SupabaseCrudAdapter } from '../common/crudAdapter';
import { weightCheckEntity as product } from '@dndev/test-entities';

const schemas = createSchemas(product);

const violation = (constraint: string) => ({
  code: '23514',
  message: `new row for relation "weight_checks" violates check constraint "${constraint}"`,
});

/** Fake PostgREST whose writes fail with `error`; a session exists. */
function client(error: unknown) {
  const result = { data: null, error };
  const chain: Record<string, unknown> = {};
  for (const m of ['insert', 'upsert', 'update', 'delete', 'select', 'eq', 'in']) chain[m] = () => chain;
  chain.single = async () => result;
  chain.then = (ok: (v: unknown) => unknown) => Promise.resolve(result).then(ok);
  const auth = {
    getSession: vi.fn(async () => ({ data: { session: { user: { id: 'u1' } } }, error: null })),
    onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
  };
  return { from: vi.fn(() => chain), auth } as unknown as SupabaseClient;
}

describe('generated CHECK constraint names', () => {
  it('round-trips <table>_<column>_<rule> for every rule', () => {
    for (const rule of CHECK_RULES) {
      const name = checkConstraintName('weight_checks', 'weight_grams', rule);
      expect(name).toBe(`weight_checks_weight_grams_${rule}`);
      expect(parseCheckConstraintName('weight_checks', name)).toEqual({ column: 'weight_grams', rule });
    }
    expect(parseCheckConstraintName('weight_checks', 'orders_total_range')).toBeNull();
    expect(parseCheckConstraintName('weight_checks', 'weight_checks_hand_written')).toBeNull();
  });

  it('refuses names Postgres would truncate', () => {
    expect(() => checkConstraintName('t'.repeat(40), 'c'.repeat(20), 'required')).toThrow(/exceeds 63/);
  });

  it('maps only 23514 errors of generated constraints of the table', () => {
    const toField = (c: string) => c;
    expect(mapCheckViolation(violation('weight_checks_name_required'), 'weight_checks', toField)).toMatchObject({
      field: 'name',
      rule: 'required',
      i18nKey: 'crud:childRows.required',
    });
    expect(mapCheckViolation(violation('weight_checks_name_length'), 'weight_checks', toField)?.i18nKey).toBe('crud:childRows.invalidValue');
    expect(mapCheckViolation({ code: '23505', message: 'duplicate' }, 'weight_checks', toField)).toBeNull();
    expect(mapCheckViolation(violation('routines_published_content'), 'weight_checks', toField)).toBeNull();
  });
});

describe('SupabaseCrudAdapter — 23514 mapping', () => {
  it('add(): field + i18n key, same message key as the client', async () => {
    const adapter = new SupabaseCrudAdapter(client(violation('weight_checks_weight_grams_range')));
    const err = await adapter.add('weight_checks', { weightGrams: 5, status: 'available' }, schemas.create).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoNotDevError);
    expect(err).toMatchObject({
      code: 'validation-failed',
      details: { field: 'weightGrams', rule: 'range', constraint: 'weight_checks_weight_grams_range', i18nKey: 'crud:childRows.invalidValue' },
    });
  });

  it('update(): other errors keep the generic wrapping', async () => {
    const adapter = new SupabaseCrudAdapter(client({ code: '42501', message: 'permission denied' }));
    const err = await adapter.update('weight_checks', 'p1', { weightGrams: 5 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DoNotDevError);
    expect((err as DoNotDevError).code).not.toBe('validation-failed');
  });
});

describe('SupabaseCrudAdapter.bulk — 23514 mapping', () => {
  it('failed inserts and updates carry the field + i18n key', async () => {
    const adapter = new SupabaseCrudAdapter(client(violation('weight_checks_weight_grams_range')));
    const result = await adapter.bulk(
      'weight_checks',
      { inserts: [{ weightGrams: 5, status: 'available' }], updates: [{ id: 'p1', patch: { weightGrams: 7 } }] },
      schemas.create
    );
    expect(result.failed).toEqual([
      expect.objectContaining({ op: 'insert', index: 0, field: 'weightGrams', i18nKey: 'crud:childRows.invalidValue' }),
      expect.objectContaining({ op: 'update', id: 'p1', field: 'weightGrams', i18nKey: 'crud:childRows.invalidValue' }),
    ]);
  });

  it('other errors carry no field', async () => {
    const adapter = new SupabaseCrudAdapter(client({ code: '42501', message: 'permission denied' }));
    const result = await adapter.bulk('weight_checks', { deletes: ['p1'] });
    expect(result.failed).toEqual([{ op: 'delete', id: 'p1', error: 'permission denied' }]);
  });
});
