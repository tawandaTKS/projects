/** Quote a DuckDB identifier. */
export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

/** Quote a DuckDB string literal. */
export function sqlString(value: string): string {
  return "'" + value.replace(/'/g, "''") + "'";
}

const RESERVED = new Set(['select', 'from', 'where', 'table', 'order', 'group', 'by', 'join', 'limit', 'with', 'union', 'all', 'as', 'on', 'and', 'or', 'not', 'null', 'case', 'when', 'then', 'else', 'end', 'having', 'distinct', 'in', 'is', 'like', 'between', 'user', 'default', 'check', 'column', 'create', 'drop', 'insert', 'update', 'delete']);

/** Turn a file name (and optional sheet) into a friendly, unique, lowercase SQL table name. */
export function toTableName(fileName: string, existing: Iterable<string>, sheet?: string): string {
  const base = fileName.replace(/^.*[\\/]/, '').replace(/\.(csv|tsv|txt|parquet|pq|xlsx|xlsm|json|jsonl|ndjson)$/i, '');
  let name = (sheet ? `${base}_${sheet}` : base)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  if (!name) name = 'data';
  if (/^[0-9]/.test(name) || RESERVED.has(name)) name = 't_' + name;
  if (name.startsWith('__')) name = 't' + name;
  const taken = new Set([...existing].map((n) => n.toLowerCase()));
  let candidate = name;
  for (let i = 2; taken.has(candidate); i++) candidate = `${name}_${i}`;
  return candidate;
}

export type FileFormat = 'csv' | 'parquet' | 'excel' | 'json';

export function detectFormat(fileName: string): FileFormat | null {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (['csv', 'tsv', 'txt'].includes(ext)) return 'csv';
  if (['parquet', 'pq'].includes(ext)) return 'parquet';
  if (['xlsx', 'xlsm'].includes(ext)) return 'excel';
  if (['json', 'jsonl', 'ndjson'].includes(ext)) return 'json';
  return null;
}

export const SUPPORTED_EXTENSIONS = ['csv', 'tsv', 'txt', 'parquet', 'pq', 'xlsx', 'xlsm', 'json', 'jsonl', 'ndjson'];
