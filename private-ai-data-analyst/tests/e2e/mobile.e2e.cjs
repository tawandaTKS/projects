// Mobile web bundle in a phone-sized Chromium: DuckDB-WASM import of CSV, Excel and Parquet, then Q&A.
// Run: node tests/e2e/mobile.e2e.cjs   (builds the mobile app twice: with and without the CSP)
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./mockOllama.cjs');

const mobileDir = path.join(__dirname, '../../apps/mobile');
const root = path.join(__dirname, '../..');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://localhost:${PORT}/`;

async function makeFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'invoices.csv'), 'Invoice,Client,Region,Amount,Date\n1,Café Nord,North,1200.50,2024-01-15\n2,Acme,South,800,2024-01-20\n3,Acme,South,450.25,2024-02-03\n4,Zed,North,3000,2024-02-28\n');
  const ExcelJS = require(require.resolve('exceljs', { paths: [root] }));
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Staff').addRows([['Employee', 'Department', 'Salary'], ['Ann', 'HR', 52000], ['Bob', 'Finance', 61000]]);
  await wb.xlsx.writeFile(path.join(dir, 'hr.xlsx'));
  const { DuckDBInstance } = require(require.resolve('@duckdb/node-api', { paths: [root] }));
  const c = await (await DuckDBInstance.create(':memory:')).connect();
  await c.run(`COPY (SELECT range AS id, range * 2.5 AS score, DATE '2024-01-01' + range::INT AS day FROM range(50)) TO '${path.join(dir, 'scores.parquet')}' (FORMAT parquet, COMPRESSION zstd)`);
}

function buildTo(outDir, env) {
  console.log('building', outDir);
  execSync(`npx vite build --outDir ${outDir}`, { cwd: mobileDir, env: { ...process.env, ...env }, stdio: 'ignore', timeout: 120000 });
}

async function serve(outDir) {
  const vite = path.join(root, 'node_modules/vite/bin/vite.js');
  const proc = spawn(process.execPath, [vite, 'preview', '--outDir', outDir, '--port', String(PORT), '--strictPort'], { cwd: mobileDir, stdio: 'pipe', detached: true });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('vite preview did not start')), 20000);
    proc.stdout.on('data', (d) => String(d).includes(String(PORT)) && (clearTimeout(timer), resolve()));
    proc.on('exit', (code) => reject(new Error(`vite preview exited (${code})`)));
  });
  return {
    kill: () => {
      try {
        process.kill(-proc.pid);
      } catch {}
    },
  };
}

async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  return ctx.newPage();
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pada-m-'));
  await makeFixtures(dir);
  const shots = process.env.SHOTS_DIR || dir;
  buildTo('dist-e2e-csp', {});
  buildTo('dist-e2e-nocsp', { PADA_NO_CSP: '1' });
  const mock = await start();
  const browser = await chromium.launch();

  // Phase 1: production build with CSP.
  let server = await serve('dist-e2e-csp');
  try {
    const page = await phone(browser);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(BASE);
    await page.getByText('Your private data analyst').waitFor({ timeout: 30000 });
    await page.locator('input[type=file]').setInputFiles(['invoices.csv', 'hr.xlsx', 'scores.parquet'].map((f) => path.join(dir, f)));
    await page.getByText(/Added invoices/).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Show datasets' }).click();
    for (const t of ['invoices', 'hr', 'scores']) await page.locator('.tname', { hasText: new RegExp(`^${t}$`) }).waitFor();
    await page.locator('.table-row', { hasText: 'scores' }).click();
    await page.getByText('day', { exact: true }).waitFor();
    assert.equal(await page.locator('.table-detail .ctype').nth(2).textContent(), 'date');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'mobile-drawer.png') });
    // The CSP forbids the WebView from making network requests.
    const net = await page.evaluate(() => fetch('https://example.com').then(() => 'reached', () => 'blocked'));
    assert.equal(net, 'blocked');
    assert.deepEqual(errors, []);
  } finally {
    server.kill();
  }

  // Phase 2: Q&A flow (CSP off so the browser can call the mock directly; devices use native HTTP).
  await new Promise((r) => setTimeout(r, 500));
  server = await serve('dist-e2e-nocsp');
  try {
    const page = await phone(browser);
    await page.goto(BASE);
    await page.evaluate((url) => localStorage.setItem('pada.settings', JSON.stringify({ ollamaUrl: url })), mock.url);
    await page.reload();
    await page.getByText('Your private data analyst').waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(shots, 'mobile-empty.png') });
    await page.locator('input[type=file]').setInputFiles([path.join(dir, 'invoices.csv')]);
    await page.getByText('Ask anything about your data').waitFor({ timeout: 30000 });
    await page.getByLabel('Question').fill('Show the amount by month');
    await page.getByRole('button', { name: 'Ask' }).click();
    await page.locator('.card.answer').waitFor({ timeout: 30000 });
    assert.ok(await page.locator('.recharts-line').count(), 'line chart rendered');
    await page.getByRole('tab', { name: 'Table' }).click();
    assert.equal(await page.locator('.card.answer tbody tr').count(), 2);
    assert.match(await page.locator('.card.answer tbody tr').first().textContent(), /2024-01-01/);
    await page.getByRole('tab', { name: 'Chart' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(shots, 'mobile-answer.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: path.join(shots, 'mobile-answer-dark.png') });
    console.log(`Mobile E2E passed. Screenshots in ${shots}`);
  } finally {
    server.kill();
    await browser.close();
    mock.server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
