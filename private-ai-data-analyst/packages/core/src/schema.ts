import { quoteIdent } from './identifiers';
import type { ColumnProfile, SqlRunner, TableInfo } from './types';
import { isNumericType, isTemporalType } from './values';

const MAX_DISTINCT_LISTED = 25;
const MAX_PROFILED_COLUMNS = 60;

/** Collect column types, row count, ranges and low-cardinality values so the model can write accurate SQL. */
export async function profileTable(runner: SqlRunner, table: string): Promise<Pick<TableInfo, 'rowCount' | 'columns' | 'sampleRows'>> {
  const t = quoteIdent(table);
  const described = await runner.run(`DESCRIBE ${t}`, 10000);
  const columns: ColumnProfile[] = described.rows.map((r) => ({ name: String(r.column_name), type: String(r.column_type) }));
  const count = await runner.run(`SELECT count(*) AS n FROM ${t}`, 1);
  const rowCount = Number(count.rows[0]?.n ?? 0);
  const sample = await runner.run(`SELECT * FROM ${t} LIMIT 3`, 3);

  const profiled = columns.slice(0, MAX_PROFILED_COLUMNS);
  if (profiled.length && rowCount > 0) {
    const parts: string[] = [];
    profiled.forEach((c, i) => {
      const q = quoteIdent(c.name);
      parts.push(`count(*) - count(${q}) AS "n${i}"`);
      if (isNumericType(c.type) || isTemporalType(c.type)) {
        parts.push(`CAST(min(${q}) AS VARCHAR) AS "lo${i}"`, `CAST(max(${q}) AS VARCHAR) AS "hi${i}"`);
      } else if (/^VARCHAR/i.test(c.type)) {
        parts.push(`approx_count_distinct(${q}) AS "d${i}"`);
      }
    });
    const stats = (await runner.run(`SELECT ${parts.join(', ')} FROM ${t}`, 1)).rows[0] ?? {};
    for (let i = 0; i < profiled.length; i++) {
      const c = profiled[i];
      c.nulls = Number(stats[`n${i}`] ?? 0);
      if (stats[`lo${i}`] != null) c.min = String(stats[`lo${i}`]);
      if (stats[`hi${i}`] != null) c.max = String(stats[`hi${i}`]);
      const distinct = Number(stats[`d${i}`] ?? Infinity);
      if (distinct <= MAX_DISTINCT_LISTED + 5) {
        const q = quoteIdent(c.name);
        const vals = await runner.run(
          `SELECT ${q} AS v, count(*) AS n FROM ${t} WHERE ${q} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT ${MAX_DISTINCT_LISTED + 1}`,
          MAX_DISTINCT_LISTED + 1,
        );
        if (vals.rows.length <= MAX_DISTINCT_LISTED) c.values = vals.rows.map((r) => String(r.v));
      }
    }
  }
  return { rowCount, columns, sampleRows: sample.rows };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Render the schema as compact text for the model's context window. */
export function describeSchema(tables: TableInfo[], includeSampleRows: boolean): string {
  if (!tables.length) return '(no tables loaded)';
  return tables
    .map((t) => {
      const lines = [`TABLE ${quoteIdent(t.name)} -- from ${t.sourceFile}${t.sheet ? ` (sheet "${t.sheet}")` : ''}, ${t.rowCount.toLocaleString('en-US')} rows`];
      for (const c of t.columns) {
        let line = `  ${quoteIdent(c.name)} ${c.type}`;
        const notes: string[] = [];
        if (c.values?.length) notes.push(`values: ${truncate(c.values.map((v) => JSON.stringify(v)).join(', '), 400)}`);
        if (c.min !== undefined && c.max !== undefined) notes.push(`range ${c.min} to ${c.max}`);
        if (c.nulls && t.rowCount) notes.push(`${Math.round((c.nulls / t.rowCount) * 100)}% null`);
        if (notes.length) line += ' -- ' + notes.join('; ');
        lines.push(line);
      }
      if (includeSampleRows && t.sampleRows.length) {
        lines.push('  sample rows:');
        for (const r of t.sampleRows) lines.push('    ' + truncate(JSON.stringify(r), 500));
      }
      return lines.join('\n');
    })
    .join('\n\n');
}
