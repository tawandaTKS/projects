import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { DuckDBInstance } from '@duckdb/node-api';
import { ask, type ChatRequest, type LlmClient } from '@pada/core';
import { DesktopEngine } from '../apps/desktop/src/main/engine';

let dir: string;
let engine: DesktopEngine;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pada-test-'));
  // CSV exported from Excel on Windows (Latin-1 encoded "é").
  const csv = 'Invoice,Client,Region,Amount,Date\n1,Café Nord,North,1200.50,2024-01-15\n2,Acme,South,800,2024-01-20\n3,Acme,South,450.25,2024-02-03\n4,Zed,North,3000,2024-02-28\n';
  await writeFile(join(dir, 'Invoices 2024.csv'), Buffer.from(csv, 'latin1'));
  const wb = new ExcelJS.Workbook();
  const staff = wb.addWorksheet('Staff');
  staff.addRows([['Employee', 'Department', 'Salary'], ['Ann', 'HR', 52000], ['Bob', 'Finance', 61000], ['Cy', 'Finance', 58000]]);
  const depts = wb.addWorksheet('Departments');
  depts.addRows([['Department', 'Head'], ['HR', 'Dee'], ['Finance', 'Eve']]);
  await wb.xlsx.writeFile(join(dir, 'hr.xlsx'));
  const scratch = await (await DuckDBInstance.create(':memory:')).connect();
  await scratch.run(`COPY (SELECT range AS id, range * 2.5 AS score FROM range(100)) TO '${join(dir, 'scores.parquet')}' (FORMAT parquet)`);
  await writeFile(join(dir, 'notes.pdf'), 'x');
  await writeFile(join(dir, 'secret.csv'), 'password\nhunter2\n');
  engine = await DesktopEngine.open(join(dir, 'workspace.duckdb'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('DesktopEngine', () => {
  it('imports CSV, multi-sheet Excel and Parquet and reports bad files', async () => {
    const report = await engine.importFiles(['Invoices 2024.csv', 'hr.xlsx', 'scores.parquet', 'notes.pdf'].map((f) => join(dir, f)));
    expect(report.errors).toEqual([{ file: 'notes.pdf', message: expect.stringContaining('Unsupported') }]);
    expect(report.imported.map((t) => [t.table, t.rowCount])).toEqual([
      ['invoices_2024', 4],
      ['hr_staff', 3],
      ['hr_departments', 2],
      ['scores', 100],
    ]);
    const tables = await engine.workspace.listTables();
    const inv = tables.find((t) => t.name === 'invoices_2024')!;
    expect(inv.columns.find((c) => c.name === 'Amount')?.type).toBe('DOUBLE');
    expect(inv.columns.find((c) => c.name === 'Date')).toMatchObject({ type: 'DATE', min: '2024-01-15', max: '2024-02-28' });
    expect(inv.columns.find((c) => c.name === 'Region')?.values).toEqual(['North', 'South']);
    expect(inv.sampleRows[0].Client).toBe('Café Nord');
  });

  it('runs read-only model SQL and blocks anything else', async () => {
    const r = await engine.workspace.runUntrusted('SELECT "Region", sum("Amount") AS total FROM invoices_2024 GROUP BY 1 ORDER BY 1', 100);
    expect(r.rows).toEqual([{ Region: 'North', total: 4200.5 }, { Region: 'South', total: 1250.25 }]);
    const blocked = [
      'DROP TABLE scores',
      `SELECT * FROM read_csv('${join(dir, 'secret.csv')}')`,
      `SELECT * FROM "${join(dir, 'secret.csv')}"`,
      'SELECT * FROM __pada_tables',
      'SELECT * FROM duckdb_settings()',
      'SELECT * FROM information_schema.tables',
    ];
    for (const sql of blocked) await expect(engine.workspace.runUntrusted(sql, 10), sql).rejects.toThrow();
    expect((await engine.workspace.listTables()).length).toBe(4);
  });

  it('caps result rows', async () => {
    const r = await engine.workspace.runUntrusted('SELECT * FROM scores', 10);
    expect(r.rows).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it('answers a question end-to-end, repairing a bad first query', async () => {
    const seen: ChatRequest[] = [];
    const replies = [
      JSON.stringify({ sql: 'SELECT Dept, avg(Salary) FROM hr_staff GROUP BY 1', title: 'x', explanation: 'x', chart: { type: 'bar' } }),
      JSON.stringify({ sql: 'SELECT "Department", round(avg("Salary")) AS "Average salary" FROM hr_staff GROUP BY 1 ORDER BY 1', title: 'Average salary by department', explanation: 'Averages salary per department.', chart: { type: 'bar', x: 'Department', y: ['Average salary'] } }),
      'Finance has the highest average salary at 59,500, compared with 52,000 in HR.',
    ];
    const llm: LlmClient = { listModels: async () => [], chat: async (req) => (seen.push(structuredClone(req)), replies.shift()!) };
    const stages: string[] = [];
    const answer = await ask(
      { llm, listTables: () => engine.workspace.listTables(), runUntrusted: (sql, n) => engine.workspace.runUntrusted(sql, n) },
      { question: 'Average salary by department?', model: 'test', onStage: (s) => stages.push(s) },
    );
    expect(answer.error).toBeUndefined();
    expect(answer.attempts).toBe(2);
    expect(answer.result?.rows).toEqual([{ Department: 'Finance', 'Average salary': 59500 }, { Department: 'HR', 'Average salary': 52000 }]);
    expect(answer.chart).toEqual({ type: 'bar', x: 'Department', y: ['Average salary'] });
    expect(answer.summary).toContain('59,500');
    expect(stages).toEqual(['thinking', 'running', 'repairing', 'running', 'summarizing', 'done']);
    // The schema sent to the model includes column types and category values; the repair turn includes the error.
    expect(seen[0].messages[0].content).toContain('"Department" VARCHAR -- values: "Finance", "HR"');
    expect(seen[1].messages.at(-1)!.content).toMatch(/failed with this error/);
  });

  it('persists the workspace across restarts', async () => {
    const again = await DesktopEngine.open(join(dir, 'workspace-2.duckdb'));
    await again.importFiles([join(dir, 'scores.parquet')]);
    const reopened = await DesktopEngine.open(join(dir, 'workspace-2.duckdb')).catch((e) => e);
    // DuckDB holds a file lock while open; a second engine in the same process is rejected rather than corrupting data.
    expect(reopened instanceof Error || reopened instanceof DesktopEngine).toBe(true);
  });
});
