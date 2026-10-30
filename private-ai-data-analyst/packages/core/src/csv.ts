import type { QueryResult } from './types';

export function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\r\n]/.test(s) || /^\s|\s$/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function rowsToCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(r.map(csvEscape).join(','));
  return lines.join('\n') + '\n';
}

export function resultToCsv(result: QueryResult): string {
  const header = result.columns.map((c) => c.name);
  return rowsToCsv(header, result.rows.map((r) => header.map((h) => r[h])));
}
