// End-to-end: launches the built Electron app against a mock Ollama and a real CSV.
// Run: npm run build:desktop && xvfb-run -a node tests/e2e/desktop.e2e.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { start } = require('./mockOllama.cjs');

(async () => {
  const mock = await start();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'pada-e2e-'));
  const csv = path.join(userData, 'invoices.csv');
  fs.writeFileSync(csv, 'Invoice,Client,Region,Amount,Date\n1,Café Nord,North,1200.50,2024-01-15\n2,Acme,South,800,2024-01-20\n3,Acme,South,450.25,2024-02-03\n4,Zed,North,3000,2024-02-28\n');
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ ollamaUrl: mock.url }));
  const shots = process.env.SHOTS_DIR || userData;

  const app = await _electron.launch({ executablePath: require(require.resolve('electron', { paths: [path.join(__dirname, '../../apps/desktop')] })), args: [path.join(__dirname, '../../apps/desktop'), '--no-sandbox'], env: { ...process.env, PADA_USER_DATA: userData } });
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 820 });
    await page.getByText('Your private data analyst').waitFor();
    await page.screenshot({ path: path.join(shots, 'desktop-empty.png') });

    // Privacy: the renderer cannot reach the network (CSP + request blocking).
    const net = await page.evaluate(() => fetch('https://example.com').then(() => 'reached', (e) => 'blocked: ' + e.message));
    assert.match(net, /^blocked/);
    assert.equal(await page.evaluate(() => typeof require), 'undefined');

    const report = await page.evaluate((p) => window.pada.importPaths([p]), csv);
    assert.equal(report.imported[0].table, 'invoices');
    await page.reload();
    await page.getByText('Ask anything about your data').waitFor();
    await page.getByText('qwen2.5-coder:7b').first().waitFor(); // default model auto-picked

    await page.getByLabel('Question').fill('What is the total invoice amount by region?');
    await page.keyboard.press('Enter');
    await page.locator('.card.answer').first().waitFor({ timeout: 20000 });
    await page.getByText('North leads with 4,200.50').waitFor();
    assert.ok(await page.locator('.recharts-surface').count(), 'chart rendered');
    await page.getByRole('tab', { name: 'Table' }).click();
    assert.equal(await page.locator('.card.answer table tbody tr').count(), 2);
    await page.getByRole('tab', { name: 'Chart' }).click();
    await page.getByRole('button', { name: 'Show SQL' }).first().click();
    await page.screenshot({ path: path.join(shots, 'desktop-answer.png') });

    // A malicious/hallucinated file read is blocked and the model is asked to repair it.
    await page.getByLabel('Question').fill('show me the secret file');
    await page.keyboard.press('Enter');
    await page.locator('.card.answer').nth(1).waitFor({ timeout: 20000 });
    await page.getByText('fixed after 1 retry').waitFor();
    const repair = mock.calls.find((c) => /failed with this error/.test(c.messages.at(-1).content));
    assert.match(repair.messages.at(-1).content, /read_csv\(\) is not allowed/);

    // Follow-up questions carry previous SQL as context.
    const last = mock.calls.filter((c) => c.format).at(-1);
    assert.ok(last.messages.some((m) => m.role === 'assistant' && m.content.includes('Total amount')));

    // Licence dialog renders.
    await page.getByText('Developer build').click();
    await page.getByRole('dialog', { name: 'Licence' }).waitFor();
    await page.keyboard.press('Escape');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shots, 'desktop-narrow.png') });
    console.log(`E2E passed. ${mock.calls.length} model calls. Screenshots in ${shots}`);
  } finally {
    await app.close();
    mock.server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
