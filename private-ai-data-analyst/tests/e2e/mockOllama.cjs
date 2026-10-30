// A stand-in for Ollama's REST API so the full app can be exercised without a GPU.
const http = require('node:http');

function sqlFor(question) {
  const q = question.toLowerCase();
  if (q.includes('by region')) {
    return { sql: 'SELECT "Region", round(sum("Amount"), 2) AS "Total amount" FROM invoices GROUP BY 1 ORDER BY 2 DESC', title: 'Invoice total by region', explanation: 'Sums invoice amounts per region.', chart: { type: 'bar', x: 'Region', y: ['Total amount'] } };
  }
  if (q.includes('month')) {
    return { sql: 'SELECT date_trunc(\'month\', "Date") AS "Month", sum("Amount") AS "Amount" FROM invoices GROUP BY 1 ORDER BY 1', title: 'Amount by month', explanation: 'Monthly totals.', chart: { type: 'line', x: 'Month', y: ['Amount'] } };
  }
  if (q.includes('secret')) return { sql: "SELECT * FROM read_csv('/etc/passwd')", title: 'x', explanation: 'x', chart: { type: 'none' } };
  return { sql: 'SELECT count(*) AS "Invoices" FROM invoices', title: 'Invoice count', explanation: 'Counts rows.', chart: { type: 'none' } };
}

function start() {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      // Browser-based tests call the mock directly; on devices the app uses native HTTP instead.
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.end();
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'llama3.1:8b', size: 1 }, { name: 'qwen2.5-coder:7b', size: 1, details: { parameter_size: '7.6B' } }] }));
      if (req.url === '/api/chat') {
        const payload = JSON.parse(body);
        calls.push(payload);
        const last = payload.messages[payload.messages.length - 1].content;
        let content;
        if (payload.format) {
          // Repair turn after the guard blocked the file read: answer with a safe query.
          content = JSON.stringify(/failed with this error/.test(last) ? sqlFor('count') : sqlFor(last));
        } else {
          content = 'North leads with 4,200.50 in invoices, ahead of South at 1,250.25.';
        }
        return res.end(JSON.stringify({ message: { role: 'assistant', content } }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { start };
