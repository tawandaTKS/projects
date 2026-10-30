import * as duckdb from '@duckdb/duckdb-wasm';
import ehWasm from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import { parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import {
  Workspace,
  createTableFromCsv,
  detectFormat,
  normalizeRows,
  rowsToCsv,
  type ImportReport,
  type QueryResult,
  type ResultColumn,
  type SqlRunner,
} from '@pada/core';

/** Map Arrow type names to DuckDB-style names so shared chart/format logic works the same everywhere. */
function arrowTypeName(type: unknown): string {
  const t = String(type);
  if (/^u?int/i.test(t)) return 'BIGINT';
  if (/^float/i.test(t)) return 'DOUBLE';
  if (/^decimal/i.test(t)) return 'DECIMAL';
  if (/^date/i.test(t)) return 'DATE';
  if (/^timestamp/i.test(t)) return 'TIMESTAMP';
  if (/^time/i.test(t)) return 'TIME';
  if (/^bool/i.test(t)) return 'BOOLEAN';
  if (/^(utf8|largeutf8)/i.test(t)) return 'VARCHAR';
  return t.toUpperCase();
}

function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const count = seen.get(n.toLowerCase()) ?? 0;
    seen.set(n.toLowerCase(), count + 1);
    return count ? `${n}_${count + 1}` : n;
  });
}

function toCsvValue(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) {
    const iso = v.toISOString();
    // Parquet DATE values decode as midnight UTC; keep them as dates so DuckDB infers DATE.
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.000Z$|Z$/, '');
  }
  return v;
}

function objectsToCsv(rows: Record<string, unknown>[]): string {
  const header: string[] = [];
  const seen = new Set<string>();
  for (const r of rows.slice(0, 1000)) for (const k of Object.keys(r)) if (!seen.has(k)) (seen.add(k), header.push(k));
  return rowsToCsv(header, rows.map((r) => header.map((h) => toCsvValue(r[h]))));
}

function parseJsonRows(text: string): Record<string, unknown>[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  if (trimmed.startsWith('{') && !trimmed.includes('\n')) {
    const obj = JSON.parse(trimmed);
    const arr = Object.values(obj).find(Array.isArray);
    return (arr as Record<string, unknown>[]) ?? [obj];
  }
  return trimmed.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * DuckDB compiled to WebAssembly, running inside the app. Data lives in memory only for the session
 * and is never written anywhere. Extension auto-loading is disabled so DuckDB never fetches code.
 */
export class WasmEngine {
  readonly workspace: Workspace;
  private readonly runner: SqlRunner;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly db: duckdb.AsyncDuckDB,
    private readonly conn: duckdb.AsyncDuckDBConnection,
  ) {
    this.runner = { run: (sql, maxRows) => this.exclusive(() => this.runRaw(sql, maxRows)) };
    this.workspace = new Workspace(this.runner);
  }

  static async open(): Promise<WasmEngine> {
    // Only the WebAssembly-exceptions build is bundled (iOS 15.2+, Android WebView 95+), halving app size.
    const worker = new Worker(ehWorker);
    const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
    await db.instantiate(ehWasm);
    await db.open({ query: { castBigIntToDouble: true, castDecimalToDouble: true, castTimestampToDate: true } });
    const conn = await db.connect();
    await conn.query('SET autoinstall_known_extensions = false');
    await conn.query('SET autoload_known_extensions = false');
    await conn.query('SET lock_configuration = true');
    const engine = new WasmEngine(db, conn);
    await engine.workspace.init();
    return engine;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runRaw(sql: string, maxRows?: number): Promise<QueryResult> {
    const started = performance.now();
    const limit = maxRows ?? 100_000;
    const reader = await this.conn.send(sql);
    let names: string[] = [];
    let columns: ResultColumn[] = [];
    const describe = (fields: { name: string; type: unknown }[]) => {
      names = uniqueNames(fields.map((f) => f.name));
      columns = fields.map((f, i) => ({ name: names[i], type: arrowTypeName(f.type) }));
    };
    const rows: Record<string, unknown>[] = [];
    let truncated = false;
    for await (const batch of reader) {
      // The stream's schema is only reliable once the first batch has arrived.
      if (!columns.length) describe(batch.schema.fields);
      for (let r = 0; r < batch.numRows; r++) {
        if (rows.length >= limit) {
          truncated = true;
          break;
        }
        const row: Record<string, unknown> = {};
        for (let c = 0; c < names.length; c++) row[names[c]] = batch.getChildAt(c)?.get(r);
        rows.push(row);
      }
      if (truncated) break;
    }
    if (!columns.length && reader.schema) describe(reader.schema.fields);
    if (truncated) await this.conn.cancelSent().catch(() => undefined);
    return { columns, rows: normalizeRows(columns, rows), truncated, elapsedMs: Math.round(performance.now() - started) };
  }

  private async importCsvText(fileName: string, csv: string | Uint8Array, sheet?: string): Promise<{ table: string; rowCount: number }> {
    const table = await this.workspace.allocateName(fileName, sheet);
    const virtualName = `${table}.csv`;
    if (typeof csv === 'string') await this.db.registerFileText(virtualName, csv);
    else await this.db.registerFileBuffer(virtualName, csv);
    try {
      await createTableFromCsv(this.runner, table, virtualName);
    } finally {
      await this.db.dropFile(virtualName).catch(() => undefined);
    }
    const info = await this.workspace.register(table, fileName, sheet);
    return { table, rowCount: info.rowCount };
  }

  async importFiles(files: File[]): Promise<ImportReport> {
    const report: ImportReport = { imported: [], errors: [] };
    for (const file of files) {
      try {
        const format = detectFormat(file.name);
        if (!format) throw new Error('Unsupported file type. Use CSV, Excel (.xlsx), Parquet or JSON.');
        const buffer = await file.arrayBuffer();
        if (format === 'csv') {
          report.imported.push({ ...(await this.importCsvText(file.name, new Uint8Array(buffer))), sourceFile: file.name });
        } else if (format === 'excel') {
          const { excelToCsv } = await import('@pada/core/excel');
          const sheets = await excelToCsv(buffer);
          if (!sheets.length) throw new Error('No sheets with a header row and data were found.');
          for (const s of sheets) {
            const res = await this.importCsvText(file.name, s.csv, sheets.length > 1 ? s.sheet : undefined);
            report.imported.push({ ...res, sourceFile: file.name, sheet: s.sheet });
          }
        } else if (format === 'parquet') {
          // Parquet is decoded in JavaScript so DuckDB never needs to download its parquet extension.
          const rows = (await parquetReadObjects({ file: buffer, compressors })) as Record<string, unknown>[];
          report.imported.push({ ...(await this.importCsvText(file.name, objectsToCsv(rows))), sourceFile: file.name });
        } else {
          const rows = parseJsonRows(new TextDecoder().decode(buffer));
          report.imported.push({ ...(await this.importCsvText(file.name, objectsToCsv(rows))), sourceFile: file.name });
        }
      } catch (e) {
        report.errors.push({ file: file.name, message: (e as Error).message });
      }
    }
    return report;
  }
}
