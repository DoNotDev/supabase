// packages/providers/supabase/src/__tests__/publicEntityReads.test.ts

/**
 * @fileoverview Public entity reads (sitemap, llms.txt, entity pages) on Supabase
 * @description The framework's record readers (`readEntityPageRecord`, `listStaticParams`,
 * `buildSitemap`) query `SupabasePublicReader` with the entity's read schema
 * (`entityReadSchemas`). Rows then keep the entity's field names, with every column RLS
 * returns (`select=*`, no visibility filter), as before the schema was passed.
 *
 * - snake_case entity (isousou shape): without the schema the reader camelCased every
 *   column (`availability_date` → `availabilityDate`): the entity page title lost
 *   `district_code` and its description read "undefined" (`displayValue` got no value).
 * - camelCase entity with technical `status` / `updatedAt` (shopkb shape): a guest-filtered
 *   read would drop both, and with them Product `availability` and the sitemap `lastmod`.
 */

import { describe, it, expect, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildBreadcrumbJsonLd,
  buildProductJsonLd,
  createSchemas,
  defineEntity,
  deriveEntitySeo,
  HIDDEN_STATUSES,
  languageUrl,
  languageUrls,
} from '@donotdev/core';

import { SupabasePublicReader } from '../server/publicReader';
import { entityPageSeo, readEntityPageRecord } from '../../../../core/config/next/seo/entityPage.js';
import { entityReadSchemas } from '../../../../core/config/utils/entityRecordSeo.js';
import { listStaticParams } from '../../../../core/config/utils/publicPages.js';
import { buildSitemap } from '../../../../core/config/utils/sitemap.js';

/** A rental listing with snake_case columns, titled from two of them (isousou shape). */
const flatEntity = defineEntity({
  name: 'Flat',
  collection: 'flats',
  namespace: 'entity-flat',
  listCardFields: {
    titleSeparator: ' - ',
    title: ['district_code', 'size'],
    subtitle: ['rent_cc', 'availability_date'],
  },
  fields: {
    status: {
      name: 'status',
      label: 'fields.status',
      type: 'select',
      visibility: 'guest',
      validation: {
        options: [
          { value: 'available', label: 'status.available' },
          { value: 'reserved', label: 'status.reserved' },
        ],
      },
    },
    district_code: { name: 'district_code', label: 'fields.district_code', type: 'number', visibility: 'guest' },
    size: { name: 'size', label: 'fields.size', type: 'number', visibility: 'guest' },
    rent_cc: { name: 'rent_cc', label: 'fields.rent_cc', type: 'number', visibility: 'guest' },
    availability_date: {
      name: 'availability_date',
      label: 'fields.availability_date',
      type: 'date',
      visibility: 'guest',
      options: {
        // As apps write it: the value as text (a missing value would read "undefined")
        displayValue: (value, item) =>
          item.status === 'reserved' ? null : String(value),
      },
    },
    owner_note: { name: 'owner_note', label: 'fields.owner_note', type: 'text', visibility: 'admin' },
  },
});

/** A product with camelCase fields and a technical `status` (shopkb shape). */
const productEntity = defineEntity({
  name: 'Product',
  collection: 'products',
  namespace: 'entity-product',
  listCardFields: { title: ['name'], subtitle: [], content: [], footer: ['slug', 'rrpInclVat'] },
  fields: {
    status: {
      name: 'status',
      label: 'fields.status',
      type: 'select',
      visibility: 'technical',
      validation: { options: [{ value: 'available', label: 'status.available' }] },
    },
    name: { name: 'name', label: 'fields.name', type: 'text', visibility: 'guest' },
    slug: { name: 'slug', label: 'fields.slug', type: 'text', visibility: 'guest' },
    rrpInclVat: { name: 'rrpInclVat', label: 'fields.rrpInclVat', type: 'currency', visibility: 'guest' },
  },
});

/** Stored rows: what RLS lets a signed-out visitor read with `select=*`. */
const ROWS: Record<string, Record<string, unknown>[]> = {
  flats: [
    {
      id: 'f1',
      status: 'available',
      district_code: 11,
      size: 20,
      rent_cc: 850,
      availability_date: '2099-01-01',
      owner_note: 'Keys with the concierge',
      updated_at: '2026-11-01T00:00:00.000Z',
    },
    { id: 'f2', status: 'draft', district_code: 3, size: 9 },
  ],
  products: [
    {
      id: 'p1',
      status: 'available',
      name: 'Bakuchiol Serum',
      slug: 'serum',
      rrp_incl_vat: 32,
      updated_at: '2026-11-02T10:00:00.000Z',
      // A column the entity does not declare (shopkb keeps `supplier_moq`, unused)
      supplier_moq: 6,
    },
  ],
};

/** Fake PostgREST: `eq` / `not in` filters, column selection, no session. */
function client() {
  const selects: string[] = [];
  const from = vi.fn((table: string) => ({
    select: vi.fn((cols: string) => {
      selects.push(cols);
      let kept = ROWS[table] ?? [];
      const chain = {
        eq: (col: string, value: unknown) => {
          kept = kept.filter((row) => row[col] === value);
          return chain;
        },
        not: (col: string, _op: 'in', list: string) => {
          const values = JSON.parse(`[${list.slice(1, -1)}]`) as string[];
          kept = kept.filter((row) => !values.includes(String(row[col])));
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        then: (ok: (v: unknown) => unknown) => {
          const data = kept.map((row) =>
            cols === '*'
              ? { ...row }
              : Object.fromEntries(cols.split(',').filter((c) => c in row).map((c) => [c, row[c]]))
          );
          return Promise.resolve({ data, error: null, count: data.length }).then(ok);
        },
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

const FLATS = { path: '/appartements/:id', collection: 'flats' };
const PRODUCTS = { path: '/produits/:slug', collection: 'products' };
const ENTITIES = { flatEntity, productEntity };
/** As the generated sitemap / llms.txt routes and entity pages build them. */
const READ_SCHEMAS = entityReadSchemas(ENTITIES, [FLATS, PRODUCTS], createSchemas);
const FR = { languages: ['fr'], defaultLanguage: 'fr' };

/** entityPageSeo of a record (Product JSON-LD), translations stubbed (key → key). */
const pageSeo = (record: Record<string, unknown>, route: typeof FLATS, value: string) =>
  entityPageSeo(record, {
    route,
    value,
    language: 'fr',
    routing: FR,
    baseUrl: 'https://shop.example',
    trailingSlash: false,
    siteName: 'Shop',
    defaultImage: '/og-image.png',
    type: 'product',
    entities: ENTITIES,
    translate: () => (key: string) => key,
    deriveEntitySeo,
    buildProductJsonLd,
    buildBreadcrumbJsonLd,
    languageUrl,
    // The breadcrumb's ancestors come from the app's routes (EntityPageContext.routes)
    routes: [FLATS, PRODUCTS],
  });

describe('SupabasePublicReader with the read schema', () => {
  // Keys: the entity's field names, and the default mapper's camelCase for every other
  // column (`createEntityAwareMapper`: `reverseMap.get(dbCol) ?? snakeToCamel(dbCol)`)
  it('reads every column RLS returns (select=*), keyed by the entity field names', async () => {
    const fake = client();
    const crud = new SupabasePublicReader(fake.client);

    const record = await readEntityPageRecord(FLATS, 'f1', crud, HIDDEN_STATUSES, READ_SCHEMAS);

    expect(fake.selects).toEqual(['*']);
    expect(record).toEqual({
      id: 'f1',
      status: 'available',
      district_code: 11,
      size: 20,
      rent_cc: 850,
      availability_date: '2099-01-01',
      owner_note: 'Keys with the concierge',
      updatedAt: '2026-11-01T00:00:00.000Z',
    });
  });

  // REGRESSION: entity pages rendered "undefined" as description (meta, og, JSON-LD) and
  // dropped district_code from the title
  it('derives a snake_case entity page title and description (isousou shape)', async () => {
    const crud = new SupabasePublicReader(client().client);
    const record = await readEntityPageRecord(FLATS, 'f1', crud, HIDDEN_STATUSES, READ_SCHEMAS);

    const { metadata, jsonLd } = pageSeo(record!, FLATS, 'f1');

    expect(metadata.title).toEqual({ absolute: '11 - 20 | Shop' });
    expect(metadata.description).toBe('850 2099-01-01');
    expect(JSON.stringify({ metadata, jsonLd })).not.toContain('undefined');
    expect(jsonLd).toMatchObject({ name: '11 - 20', description: '850 2099-01-01' });
  });

  // REGRESSION: a guest-filtered read dropped the technical status and updatedAt
  it('keeps Product availability and the sitemap lastmod of technical fields (shopkb shape)', async () => {
    const crud = new SupabasePublicReader(client().client);
    const record = await readEntityPageRecord(PRODUCTS, 'serum', crud, HIDDEN_STATUSES, READ_SCHEMAS);

    // Every key the default (camelCase) mapper gave: declared fields and the other columns
    expect(record).toEqual({
      id: 'p1',
      status: 'available',
      name: 'Bakuchiol Serum',
      slug: 'serum',
      rrpInclVat: 32,
      updatedAt: '2026-11-02T10:00:00.000Z',
      supplierMoq: 6,
    });
    const { jsonLd } = pageSeo(record!, PRODUCTS, 'serum');
    expect(jsonLd).toMatchObject({
      name: 'Bakuchiol Serum',
      offers: {
        '@type': 'Offer',
        price: 32,
        priceCurrency: 'EUR',
        availability: 'https://schema.org/InStock',
      },
    });

    const entries = await buildSitemap([PRODUCTS], {
      baseUrl: 'https://shop.example',
      routing: FR,
      trailingSlash: false,
      crud,
      readSchemas: READ_SCHEMAS,
      languageUrls,
      hiddenStatuses: HIDDEN_STATUSES,
    });
    expect(entries).toEqual([
      {
        url: 'https://shop.example/produits/serum',
        changeFrequency: 'weekly',
        priority: 0.7,
        lastModified: '2026-11-02T10:00:00.000Z',
      },
    ]);
  });

  it('fills the route param from the record field of that name (sitemap, prerender)', async () => {
    const crud = new SupabasePublicReader(client().client);
    expect(await listStaticParams(FLATS, crud, HIDDEN_STATUSES, READ_SCHEMAS)).toEqual([
      { id: 'f1' },
    ]);
  });
});
