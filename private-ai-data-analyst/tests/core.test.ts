import { describe, expect, it } from 'vitest';
import {
  classifyHost,
  evaluateLicense,
  generateKeyPair,
  hostAllowed,
  parsePlan,
  pickDefaultModel,
  resolveChart,
  signLicense,
  toTableName,
  canAsk,
  type LicensePayload,
  type QueryResult,
} from '@pada/core';
import { excelToCsv } from '@pada/core/excel';
import ExcelJS from 'exceljs';

describe('toTableName', () => {
  it('makes friendly unique names', () => {
    expect(toTableName('Q3 Payroll (final).xlsx', [])).toBe('q3_payroll_final');
    expect(toTableName('2024 sales.csv', [])).toBe('t_2024_sales');
    expect(toTableName('sales.csv', ['sales'])).toBe('sales_2');
    expect(toTableName('Café Données.csv', [])).toBe('cafe_donnees');
    expect(toTableName('book.xlsx', [], 'Sheet 1')).toBe('book_sheet_1');
    expect(toTableName('select.csv', [])).toBe('t_select');
  });
});

describe('network privacy', () => {
  it('classifies hosts', () => {
    expect(classifyHost('http://127.0.0.1:11434')).toBe('loopback');
    expect(classifyHost('http://localhost:11434')).toBe('loopback');
    expect(classifyHost('http://192.168.1.20:11434')).toBe('private');
    expect(classifyHost('http://10.0.0.5:11434')).toBe('private');
    expect(classifyHost('http://office-pc.local:11434')).toBe('private');
    expect(classifyHost('https://api.example.com')).toBe('public');
    expect(classifyHost('http://8.8.8.8')).toBe('public');
    expect(classifyHost('ftp://x')).toBe('invalid');
  });
  it('blocks public model servers unless explicitly allowed', () => {
    expect(hostAllowed('https://api.example.com', false).ok).toBe(false);
    expect(hostAllowed('https://api.example.com', true).ok).toBe(true);
    expect(hostAllowed('http://127.0.0.1:11434', false).ok).toBe(true);
  });
});

describe('parsePlan', () => {
  it('parses clean JSON', () => {
    const p = parsePlan('{"sql":"SELECT 1","title":"One","explanation":"e","chart":{"type":"bar","x":"a","y":"b"}}');
    expect(p.sql).toBe('SELECT 1');
    expect(p.chart.y).toEqual(['b']);
  });
  it('tolerates fences and bare SQL', () => {
    expect(parsePlan('Here you go:\n```json\n{"sql":"SELECT 2"}\n```').sql).toBe('SELECT 2');
    expect(parsePlan('SELECT 3 FROM t').sql).toBe('SELECT 3 FROM t');
    expect(() => parsePlan('I cannot help')).toThrow();
  });
});

describe('resolveChart', () => {
  const result = (columns: [string, string][], rows: Record<string, unknown>[]): QueryResult => ({
    columns: columns.map(([name, type]) => ({ name, type })),
    rows,
    truncated: false,
    elapsedMs: 1,
  });
  it('defaults to line for time series and bar for categories', () => {
    const ts = result([['Month', 'DATE'], ['Total', 'DOUBLE']], [{ Month: '2024-01-01', Total: 1 }, { Month: '2024-02-01', Total: 2 }]);
    expect(resolveChart(undefined, ts)).toEqual({ type: 'line', x: 'Month', y: ['Total'] });
    const cat = result([['Region', 'VARCHAR'], ['Total', 'BIGINT']], [{ Region: 'N', Total: 1 }, { Region: 'S', Total: 2 }]);
    expect(resolveChart({ type: 'bar', x: 'Nope', y: ['Missing'] }, cat)).toEqual({ type: 'bar', x: 'Region', y: ['Total'] });
  });
  it('skips charts for single values', () => {
    expect(resolveChart({ type: 'bar' }, result([['n', 'BIGINT']], [{ n: 5 }])).type).toBe('none');
  });
});

describe('licensing', () => {
  const keys = generateKeyPair();
  const payload: LicensePayload = { v: 1, id: 'L-1', name: 'Acme Clinic', email: 'ops@acme.test', edition: 'pro', seats: 3, issued: '2026-01-01', updatesUntil: '2027-01-01' };
  const ctx = { publicKeyHex: keys.publicKeyHex, buildDate: '2026-10-30', firstRun: '2026-10-01T00:00:00Z', now: new Date('2026-10-30T00:00:00Z') };
  it('accepts a valid key', () => {
    const state = evaluateLicense(signLicense(payload, keys.privateKeyHex), ctx);
    expect(state.status).toBe('licensed');
    expect(canAsk(state)).toBe(true);
  });
  it('locks builds released after the update entitlement', () => {
    const state = evaluateLicense(signLicense(payload, keys.privateKeyHex), { ...ctx, buildDate: '2027-03-01' });
    expect(state.status).toBe('updates-expired');
    expect(canAsk(state)).toBe(false);
  });
  it('rejects tampered or foreign keys', () => {
    const key = signLicense(payload, keys.privateKeyHex);
    const [p, body, sig] = key.split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, updatesUntil: '2099-01-01' })).toString('base64url');
    expect(evaluateLicense(`${p}.${forged}.${sig}`, ctx).status).toBe('invalid');
    expect(evaluateLicense(signLicense(payload, generateKeyPair().privateKeyHex), ctx).status).toBe('invalid');
    expect(evaluateLicense(`${p}.${body}`, ctx).status).toBe('invalid');
  });
  it('runs a 14-day trial then stops', () => {
    expect(evaluateLicense(null, ctx)).toEqual({ status: 'trial-expired' });
    expect(evaluateLicense(null, { ...ctx, firstRun: '2026-10-25T00:00:00Z' })).toEqual({ status: 'trial', daysLeft: 9 });
    expect(evaluateLicense(null, { ...ctx, publicKeyHex: '' }).status).toBe('developer');
  });
});

describe('excelToCsv', () => {
  it('converts sheets with formulas, dates and rich text', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Staff');
    ws.addRow([]);
    ws.addRow(['Name', 'Dept', 'Start', 'Salary', 'Bonus', 'Name']);
    ws.addRow(['Ann, Jr', 'HR', new Date(Date.UTC(2021, 2, 1)), 50000, { formula: 'D3*0.1', result: 5000 }, 'dup']);
    ws.addRow([{ richText: [{ text: 'Bo' }, { text: 'b' }] }, 'IT', new Date(Date.UTC(2022, 5, 15)), 60000, null]);
    wb.addWorksheet('Empty');
    const sheets = await excelToCsv(await wb.xlsx.writeBuffer());
    expect(sheets).toHaveLength(1);
    expect(sheets[0].sheet).toBe('Staff');
    expect(sheets[0].csv).toBe('Name,Dept,Start,Salary,Bonus,Name_2\n"Ann, Jr",HR,2021-03-01,50000,5000,dup\nBob,IT,2022-06-15,60000,,\n');
  });
});

describe('pickDefaultModel', () => {
  it('prefers SQL-capable models', () => {
    expect(pickDefaultModel([{ name: 'nomic-embed-text:latest' }, { name: 'llama3.1:8b' }, { name: 'qwen2.5-coder:7b' }])).toBe('qwen2.5-coder:7b');
    expect(pickDefaultModel([{ name: 'nomic-embed-text:latest' }, { name: 'mistral:7b' }])).toBe('mistral:7b');
  });
});
