import type { ResultColumn } from './types';

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|UHUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;
const TEMPORAL = /^(DATE|TIMESTAMP|TIME)/i;

export const isNumericType = (type: string): boolean => NUMERIC.test(type.trim());
export const isTemporalType = (type: string): boolean => TEMPORAL.test(type.trim());

/** Convert driver-specific values (bigint, decimal strings, Date) into plain JSON-friendly values. */
export function normalizeValue(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER) ? Number(value) : value.toString();
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return /^DATE$/i.test(type) ? value.toISOString().slice(0, 10) : value.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
  }
  if (typeof value === 'string' && isNumericType(type)) {
    const n = Number(value);
    return Number.isFinite(n) && Math.abs(n) <= Number.MAX_SAFE_INTEGER ? n : value;
  }
  if (typeof value === 'number' && isTemporalType(type) && /^DATE$|^TIMESTAMP/i.test(type)) {
    const d = new Date(value);
    return normalizeValue(d, type);
  }
  if (typeof value === 'object') {
    const v = value as { toString?: () => string };
    if (Array.isArray(value)) return value.map((x) => normalizeValue(x, ''));
    try {
      return JSON.parse(JSON.stringify(value, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
    } catch {
      return v.toString ? v.toString() : String(value);
    }
  }
  return value;
}

export function normalizeRows(columns: ResultColumn[], rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const c of columns) out[c.name] = normalizeValue(row[c.name], c.type);
    return out;
  });
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    if (Number.isInteger(value)) return value.toLocaleString('en-US');
    return value.toLocaleString('en-US', { maximumFractionDigits: Math.abs(value) < 1 ? 4 : 2 });
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
