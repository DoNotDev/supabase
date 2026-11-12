// packages/providers/supabase/src/common/fieldMapper.ts

/**
 * @fileoverview Supabase field name mapper — single boundary for app ↔ backend (Postgres) names.
 * @description Entity field names (app) are translated to/from backend column names here only.
 * Used by SupabaseCrudAdapter (client) and Supabase Edge Function CRUD handlers.
 *
 * Mapping: camelCase (app) ↔ snake_case (backend). Always applied — no opt-out.
 *
 * @version 0.1.0
 * @since 0.0.1
 */

function camelToSnake(str: string): string {
  if (typeof str !== 'string') return String(str);
  return str
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase();
}

function snakeToCamel(str: string): string {
  if (typeof str !== 'string') return String(str);
  return str.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Timestamp keys (camelCase) that must be returned as ISO strings */
const TIMESTAMP_KEYS = new Set(['createdAt', 'updatedAt']);

function toIsoString(value: unknown): string | unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return value;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(value)) {
      return new Date(value.replace(' ', 'T')).toISOString();
    }
  }
  return value;
}

/** Bidirectional field name mapper between app (camelCase) and backend (snake_case) conventions. */
export interface SupabaseFieldMapper {
  /** App field name → backend column name */
  toBackendField(appFieldName: string): string;
  /** App-shaped object → backend-shaped object (all keys mapped) */
  toBackendKeys(obj: Record<string, unknown>): Record<string, unknown>;
  /** Backend row → app-shaped object (keys mapped, timestamps to ISO) */
  fromBackendRow(row: Record<string, unknown>): Record<string, unknown>;
}

function createFieldMapperInternal(): SupabaseFieldMapper {
  const toBackendField = (appFieldName: string): string => {
    if (typeof appFieldName !== 'string') {
      throw new TypeError(
        `Supabase field mapper: field name must be a string (e.g. "createdById"), got ${typeof appFieldName}. ` +
          'Check where query options (orderBy/where) are built — ensure "field" is the field name string, not a schema or other value.'
      );
    }
    return camelToSnake(appFieldName);
  };

  const toBackendKeys = (
    obj: Record<string, unknown>
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[camelToSnake(key)] = value;
    }
    return out;
  };

  const fromBackendRow = (
    row: Record<string, unknown>
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      const appKey = snakeToCamel(key);
      out[appKey] = TIMESTAMP_KEYS.has(appKey) ? toIsoString(value) : value;
    }
    return out;
  };

  return { toBackendField, toBackendKeys, fromBackendRow };
}

/** Default mapper (camelToSnake) for use by adapters and edge functions */
export const defaultFieldMapper = createFieldMapperInternal();

/** System fields always included in the reverse map (camelCase entity names). */
const SYSTEM_FIELDS = [
  'id',
  'createdAt',
  'updatedAt',
  'createdById',
  'updatedById',
  'status',
];

/**
 * Extract entity field names from a Valibot schema.
 * Works with any schema that has an `entries` property (object schemas).
 * Returns empty array if schema is missing or has no entries.
 *
 * @param schema - Valibot schema (or undefined)
 * @returns Array of entity field name strings
 */
export function getEntityFieldNames(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || !('entries' in schema)) return [];
  const { entries } = schema;
  if (!entries || typeof entries !== 'object') return [];
  return Object.keys(entries);
}

/**
 * Entity-aware mapper factory. Builds a reverse map from DB column (snake_case)
 * back to the entity field name as defined in the schema.
 *
 * This ensures `fromBackendRow` returns keys that match entity field names —
 * so `filterVisibleFields` can find them regardless of whether the entity
 * uses snake_case (`first_name`) or camelCase (`firstName`) field names.
 *
 * Write paths (`toBackendField`, `toBackendKeys`) are shared with the default mapper.
 *
 * @param entityFieldNames - Field names from the entity schema (use `getEntityFieldNames(schema)`)
 */
export function createEntityAwareMapper(
  entityFieldNames: string[]
): SupabaseFieldMapper {
  // Reverse: camelToSnake(entityFieldName) → entityFieldName
  // e.g. "first_name" → snake "first_name" → maps back to "first_name"
  //      "firstName"  → snake "first_name" → maps back to "firstName"
  const reverseMap = new Map<string, string>();
  for (const name of entityFieldNames) {
    reverseMap.set(camelToSnake(name), name);
  }
  for (const f of SYSTEM_FIELDS) {
    reverseMap.set(camelToSnake(f), f);
  }

  return {
    // Write paths identical to default mapper — shared logic.
    toBackendField: defaultFieldMapper.toBackendField,
    toBackendKeys: defaultFieldMapper.toBackendKeys,
    fromBackendRow: (row: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [dbCol, value] of Object.entries(row)) {
        const appKey = reverseMap.get(dbCol) ?? snakeToCamel(dbCol);
        out[appKey] = TIMESTAMP_KEYS.has(appKey) ? toIsoString(value) : value;
      }
      return out;
    },
  };
}
