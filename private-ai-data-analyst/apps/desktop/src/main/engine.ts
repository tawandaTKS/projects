import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  Workspace,
  createTableFromCsv,
  detectFormat,
  normalizeRows,
  quoteIdent,
  sqlString,
  validateSelectAst,
  type ImportReport,
  type QueryResult,
  type SqlRunner,
} from '@pada/core';
import { excelToCsv } from '@pada/core/excel';

/** Make duplicate column names unique so row objects don't silently drop values. */
function uniqueNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((n) => {
    const k = n.toLowerCase();
    const count = seen.get(k) ?? 0;
    seen.set(k, count + 1);
    return count ? `${n}_${count + 1}` : n;
  });
}

/**
 * Native DuckDB engine for the desktop app. All data stays in a local DuckDB file in the user's
 * app-data folder; extension auto-download is disabled so DuckDB itself never touches the network.
 */
export class DesktopEngine {
  readonly workspace: Workspace;
  private readonly runner: SqlRunner;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(private readonly conn: DuckDBConnection) {
    this.runner = { run: (sql, maxRows) => this.exclusive(() => this.runRaw(sql, maxRows)) };
    this.workspace = new Workspace(this.runner, (sql, tables) => this.validate(sql, tables));
  }

  static async open(dbPath: string): Promise<DesktopEngine> {
    const instance = await DuckDBInstance.create(dbPath, {
      autoinstall_known_extensions: 'false',
      autoload_known_extensions: 'false',
      allow_community_extensions: 'false',
    });
    const conn = await instance.connect();
    // Freeze settings so no query can re-enable extension loading or change anything else.
    await conn.run('SET lock_configuration = true');
    const engine = new DesktopEngine(conn);
    await engine.workspace.init();
    return engine;
  }

  /** Serialise access: one DuckDB connection, one statement at a time. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runRaw(sql: string, maxRows?: number): Promise<QueryResult> {
    const started = performance.now();
    const limit = maxRows ?? 100_000;
    const reader = await this.conn.streamAndReadUntil(sql, limit + 1);
    try {
      const names = uniqueNames(reader.columnNames());
      const types = reader.columnTypes().map((t) => t.toString());
      const columns = names.map((name, i) => ({ name, type: types[i] }));
      const raw = reader.getRowsJS();
      const truncated = raw.length > limit || !reader.done;
      const rows = raw.slice(0, limit).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
      return { columns, rows: normalizeRows(columns, rows), truncated, elapsedMs: Math.round(performance.now() - started) };
    } finally {
      reader.closeSync();
    }
  }

  /** Second line of defence: check DuckDB's own parse tree only references imported tables. */
  private async validate(sql: string, tables: string[]): Promise<string | null> {
    const res = await this.exclusive(() => this.runRaw(`SELECT json_serialize_sql(${sqlString(sql)}) AS j`, 1));
    const check = validateSelectAst(String(res.rows[0]?.j ?? ''), tables);
    return check.ok ? null : check.reason;
  }

  async importFiles(paths: string[]): Promise<ImportReport> {
    const report: ImportReport = { imported: [], errors: [] };
    for (const path of paths) {
      const file = basename(path);
      try {
        const format = detectFormat(file);
        if (!format) throw new Error('Unsupported file type. Use CSV, TSV, Excel (.xlsx), Parquet or JSON.');
        const run = (sql: string) => this.runner.run(sql);
        if (format === 'excel') {
          const sheets = await excelToCsv(await readFile(path));
          if (!sheets.length) throw new Error('No sheets with a header row and data were found.');
          // Excel is converted to CSV in a private temp folder that is deleted straight after import.
          const dir = await mkdtemp(join(tmpdir(), 'pada-'));
          try {
            for (const s of sheets) {
              const table = await this.workspace.allocateName(file, sheets.length > 1 ? s.sheet : undefined);
              const csvPath = join(dir, `${table}.csv`);
              await writeFile(csvPath, s.csv, { mode: 0o600 });
              await createTableFromCsv(this.runner, table, csvPath);
              const info = await this.workspace.register(table, file, s.sheet);
              report.imported.push({ table, sourceFile: file, sheet: s.sheet, rowCount: info.rowCount });
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
          continue;
        }
        const table = await this.workspace.allocateName(file);
        if (format === 'csv') await createTableFromCsv(this.runner, table, path);
        else if (format === 'parquet') await run(`CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM read_parquet(${sqlString(path)})`);
        else await run(`CREATE TABLE ${quoteIdent(table)} AS SELECT * FROM read_json_auto(${sqlString(path)})`);
        const info = await this.workspace.register(table, file);
        report.imported.push({ table, sourceFile: file, rowCount: info.rowCount });
      } catch (e) {
        report.errors.push({ file, message: (e as Error).message });
      }
    }
    return report;
  }
}
