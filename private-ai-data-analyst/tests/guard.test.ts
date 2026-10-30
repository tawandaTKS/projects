import { describe, expect, it } from 'vitest';
import { guardSql, looksLikeLocation } from '@pada/core';

const ok = (sql: string) => expect(guardSql(sql)).toMatchObject({ ok: true });
const bad = (sql: string) => expect(guardSql(sql).ok).toBe(false);

describe('guardSql', () => {
  it('allows ordinary analytics queries', () => {
    ok('SELECT "Region", sum("Amount") AS "Total" FROM "sales" GROUP BY 1 ORDER BY 2 DESC LIMIT 10;');
    ok(`WITH m AS (SELECT date_trunc('month', "Date") AS mo, sum(x) s FROM t GROUP BY 1) SELECT * FROM m ORDER BY mo`);
    ok('FROM sales SELECT count(*)');
    ok(`SELECT * FROM t WHERE "Status" = 'N/A' AND note ILIKE '%drop table%'`);
    ok(`SELECT 'it''s; fine' AS a FROM t -- trailing comment; with semicolon`);
    ok('(SELECT 1 FROM t)');
  });
  it('rejects writes and multiple statements', () => {
    bad('DROP TABLE sales');
    bad('SELECT 1; DROP TABLE sales');
    bad('INSERT INTO t VALUES (1)');
    bad('UPDATE t SET a = 1');
    bad('ATTACH \'x.db\'');
    bad('COPY t TO \'/tmp/out.csv\'');
    bad('PRAGMA show_tables');
    bad('SET threads = 1');
    bad('INSTALL httpfs');
    bad('SELECT * FROM t /* unterminated');
    bad("SELECT 'unterminated");
  });
  it('rejects reading files or URLs', () => {
    bad("SELECT * FROM read_csv('/etc/passwd')");
    bad("SELECT * FROM READ_PARQUET('s3://bucket/x.parquet')");
    bad("SELECT * FROM '/home/me/secret.csv'");
    bad("SELECT * FROM t, '/home/me/secret.csv'");
    bad('SELECT * FROM "C:\\Users\\me\\data.csv"');
    bad("SELECT * FROM glob('*')");
    bad("SELECT * FROM query('select 1')");
    bad("SELECT getenv('HOME')");
    bad("SELECT * FROM t JOIN 'https://evil.example/x.csv' u ON true");
  });
  it('classifies locations', () => {
    expect(looksLikeLocation('N/A')).toBe(false);
    expect(looksLikeLocation('Sales')).toBe(false);
    expect(looksLikeLocation('/etc/passwd')).toBe(true);
    expect(looksLikeLocation('data.parquet')).toBe(true);
    expect(looksLikeLocation('http://x')).toBe(true);
  });
});
