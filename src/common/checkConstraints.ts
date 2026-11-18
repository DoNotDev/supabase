// packages/providers/supabase/src/common/checkConstraints.ts

/**
 * @fileoverview Generated CHECK constraints: names, rules, messages
 * @description One place for the contract between the SQL generator
 * (`@donotdev/tooling` sqlChecks + `db-check`, which import it as
 * `@donotdev/supabase/checks`) and the Supabase CRUD adapter: generated CHECK constraints are named
 * `<table>_<column>_<rule>`, and a Postgres `23514` violation of one maps back to
 * the entity field and the i18n key the client shows for the same rule.
 *
 * No imports: the `./checks` subpath export carries no provider dependency into
 * the tooling bundle.
 *
 * @version 0.1.0
 * @since 0.2.5
 * @author AMBROISE PARK Consulting
 */

/**
 * Rules of the generated CHECK constraints (design doc §5).
 * - `required`: filled unless the row status is hidden (`draft`, `deleted`)
 * - `length`: min / max length of text
 * - `pattern`: regex (`validation.pattern`, `tel` default)
 * - `options`: static options (select, multiselect)
 * - `range`: numeric min / max
 * - `integer`: whole number
 * - `json`: JSON type of a json-kind column (array / object)
 */
export const CHECK_RULES = [
  'required',
  'length',
  'pattern',
  'options',
  'range',
  'integer',
  'json',
] as const;

/** Rule of a generated CHECK constraint. */
export type CheckRule = (typeof CHECK_RULES)[number];

/** Postgres error code of a CHECK violation. */
export const CHECK_VIOLATION_CODE = '23514';

/** Longest Postgres identifier (bytes); longer names are truncated by Postgres. */
const MAX_IDENTIFIER_LENGTH = 63;

/**
 * i18n key the client shows for a rule (`crud` namespace, `{{field}}` = field
 * label): the same keys the client uses for field values (`crud:childRows.*`).
 */
export const CHECK_RULE_I18N_KEYS: Readonly<Record<CheckRule, string>> = {
  required: 'crud:childRows.required',
  length: 'crud:childRows.invalidValue',
  pattern: 'crud:childRows.invalidValue',
  options: 'crud:childRows.invalidValue',
  range: 'crud:childRows.invalidValue',
  integer: 'crud:childRows.invalidValue',
  json: 'crud:childRows.invalidValue',
};

/**
 * Name of a generated CHECK constraint: `<table>_<column>_<rule>`.
 *
 * @param table - Table name (entity collection)
 * @param column - Column name (snake_case)
 * @param rule - Constraint rule
 * @returns The constraint name
 * @throws When the name exceeds 63 bytes (Postgres would truncate it and the
 * violation could no longer be mapped back to its field)
 *
 * @version 0.1.0
 * @since 0.2.5
 * @author AMBROISE PARK Consulting
 */
export function checkConstraintName(table: string, column: string, rule: CheckRule): string {
  const name = `${table}_${column}_${rule}`;
  if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_LENGTH) {
    throw new Error(
      `CHECK constraint name "${name}" exceeds ${MAX_IDENTIFIER_LENGTH} bytes: shorten the table or column name`
    );
  }
  return name;
}

/** Column and rule of a generated constraint name. */
export interface ParsedCheckConstraint {
  column: string;
  rule: CheckRule;
}

/**
 * Splits a generated constraint name of `table` back into column and rule.
 *
 * @param table - Table the constraint belongs to
 * @param name - Constraint name
 * @returns Column and rule, or `null` when the name is not a generated one of `table`
 *
 * @version 0.1.0
 * @since 0.2.5
 * @author AMBROISE PARK Consulting
 */
export function parseCheckConstraintName(table: string, name: string): ParsedCheckConstraint | null {
  const prefix = `${table}_`;
  if (!name.startsWith(prefix)) return null;
  const rest = name.slice(prefix.length);
  for (const rule of CHECK_RULES) {
    const suffix = `_${rule}`;
    if (rest.endsWith(suffix) && rest.length > suffix.length) {
      return { column: rest.slice(0, -suffix.length), rule };
    }
  }
  return null;
}

/** A generated CHECK violation mapped to its entity field. */
export interface CheckViolation {
  /** Entity field name */
  field: string;
  /** Column name */
  column: string;
  /** Constraint rule */
  rule: CheckRule;
  /** Constraint name */
  constraint: string;
  /** i18n key of the client message (`{{field}}` = field label) */
  i18nKey: string;
}

/** Constraint name in a Postgres CHECK violation message. */
const CONSTRAINT_IN_MESSAGE = /violates check constraint "([^"]+)"/;

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== 'object' || source === null || !(key in source)) return undefined;
  const value: unknown = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Maps a Postgres / PostgREST error to a generated CHECK violation of `table`.
 *
 * @param error - Error returned by PostgREST (`{ code, message }`)
 * @param table - Table written to
 * @param columnToField - Column name → entity field name (the adapter's field mapper)
 * @returns The violation, or `null` when the error is not a `23514` violation of a
 * generated constraint of `table`
 *
 * @example
 * ```typescript
 * const violation = mapCheckViolation(error, 'products', (c) => mapper.fromBackendField(c));
 * if (violation) t(violation.i18nKey, { field: label(violation.field) });
 * ```
 *
 * @version 0.1.0
 * @since 0.2.5
 * @author AMBROISE PARK Consulting
 */
export function mapCheckViolation(
  error: unknown,
  table: string,
  columnToField: (column: string) => string
): CheckViolation | null {
  if (readString(error, 'code') !== CHECK_VIOLATION_CODE) return null;
  const constraint = readString(error, 'message')?.match(CONSTRAINT_IN_MESSAGE)?.[1];
  if (!constraint) return null;
  const parsed = parseCheckConstraintName(table, constraint);
  if (!parsed) return null;
  return {
    field: columnToField(parsed.column),
    column: parsed.column,
    rule: parsed.rule,
    constraint,
    i18nKey: CHECK_RULE_I18N_KEYS[parsed.rule],
  };
}
