import { quoteIdent, sqlString, toTableName } from './identifiers';
import { profileTable } from './schema';
import { guardSql } from './sqlGuard';
import type { QueryResult, SqlRunner, TableInfo } from './types';

const META = '__pada_tables';

/**
 * The user's local dataset catalogue. Table metadata (profile, source file) lives in a DuckDB table
 * alongside the data so it survives restarts on desktop.
 */
export class Workspace {
  private cache: TableInfo[] | null = null;

  constructor(
    private readonly runner: SqlRunner,
    /** Extra platform validation for model-written SQL (desktop: DuckDB AST allow-list). */
    private readonly validate?: (sql: string, tables: string[]) => Promise<string | null>,
  ) {}

  async init(): Promise<void> {
    await this.runner.run(
      `CREATE TABLE IF NOT EXISTS ${META} (name VARCHAR PRIMARY KEY, source_file VARCHAR, sheet VARCHAR, imported_at VARCHAR, profile VARCHAR)`,
    );
    // Drop catalogue entries whose table no longer exists.
    await this.runner.run(`DELETE FROM ${META} WHERE name NOT IN (SELECT table_name FROM duckdb_tables())`);
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.cache) return this.cache;
    const res = await this.runner.run(`SELECT name, source_file, sheet, imported_at, profile FROM ${META} ORDER BY imported_at, name`, 10000);
    this.cache = res.rows.map((r) => {
      const profile = JSON.parse(String(r.profile ?? '{}'));
      return {
        name: String(r.name),
        sourceFile: String(r.source_file),
        sheet: r.sheet ? String(r.sheet) : undefined,
        importedAt: String(r.imported_at),
        rowCount: profile.rowCount ?? 0,
        columns: profile.columns ?? [],
        sampleRows: profile.sampleRows ?? [],
      };
    });
    return this.cache;
  }

  async allocateName(fileName: string, sheet?: string): Promise<string> {
    const existing = await this.runner.run(`SELECT table_name FROM duckdb_tables()`, 100000);
    return toTableName(fileName, existing.rows.map((r) => String(r.table_name)), sheet);
  }

  /** Call after a platform has created `table` from a file. */
  async register(table: string, sourceFile: string, sheet?: string): Promise<TableInfo> {
    const profile = await profileTable(this.runner, table);
    const importedAt = new Date().toISOString();
    await this.runner.run(`DELETE FROM ${META} WHERE name = ${sqlString(table)}`);
    await this.runner.run(
      `INSERT INTO ${META} VALUES (${sqlString(table)}, ${sqlString(sourceFile)}, ${sheet ? sqlString(sheet) : 'NULL'}, ${sqlString(importedAt)}, ${sqlString(JSON.stringify(profile))})`,
    );
    this.cache = null;
    return { name: table, sourceFile, sheet, importedAt, ...profile };
  }

  async drop(table: string): Promise<void> {
    await this.runner.run(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    await this.runner.run(`DELETE FROM ${META} WHERE name = ${sqlString(table)}`);
    this.cache = null;
  }

  async preview(table: string, rows = 100): Promise<QueryResult> {
    const known = (await this.listTables()).some((t) => t.name === table);
    if (!known) throw new Error(`Unknown table ${table}`);
    return this.runner.run(`SELECT * FROM ${quoteIdent(table)} LIMIT ${Math.max(1, Math.min(rows, 1000))}`, rows);
  }

  /** Run model-generated (untrusted) SQL after all read-only checks pass. */
  async runUntrusted(sql: string, maxRows: number): Promise<QueryResult> {
    const guard = guardSql(sql);
    if (!guard.ok) throw new Error(guard.reason);
    if (this.validate) {
      const tables = (await this.listTables()).map((t) => t.name);
      const problem = await this.validate(guard.sql, tables);
      if (problem) throw new Error(problem);
    }
    return this.runner.run(guard.sql, maxRows);
  }
}

/**
 * Create `table` from a CSV file with progressive fallbacks: default sniffing → full-file type
 * detection → Windows/Latin-1 encoding → everything as text.
 */
export async function createTableFromCsv(runner: SqlRunner, table: string, path: string): Promise<void> {
  const t = quoteIdent(table);
  const p = sqlString(path);
  const attempts = [
    `read_csv(${p}, auto_detect = true)`,
    `read_csv(${p}, auto_detect = true, sample_size = -1)`,
    `read_csv(${p}, auto_detect = true, sample_size = -1, encoding = 'latin-1')`,
    `read_csv(${p}, auto_detect = true, all_varchar = true, ignore_errors = true)`,
  ];
  let lastError: unknown;
  for (const source of attempts) {
    try {
      await runner.run(`CREATE OR REPLACE TABLE ${t} AS SELECT * FROM ${source}`);
      return;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}
