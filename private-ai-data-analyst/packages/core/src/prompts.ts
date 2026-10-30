import type { ChatMessage, QueryResult } from './types';
import { rowsToCsv } from './csv';

export interface PlanJson {
  sql: string;
  title: string;
  explanation: string;
  chart: { type: string; x?: string; y?: string[] };
}

/** JSON schema passed to Ollama's structured-output `format` so small models return parseable plans. */
export const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    sql: { type: 'string' },
    title: { type: 'string' },
    explanation: { type: 'string' },
    chart: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['bar', 'line', 'pie', 'scatter', 'none'] },
        x: { type: 'string' },
        y: { type: 'array', items: { type: 'string' } },
      },
      required: ['type'],
    },
  },
  required: ['sql', 'title', 'explanation', 'chart'],
} as const;

export function sqlSystemPrompt(schema: string, today: string): string {
  return `You are an expert data analyst. You answer questions about the user's data by writing a single DuckDB SQL query.
Everything runs locally on the user's computer.

Today's date is ${today}.

DATABASE SCHEMA
${schema}

RULES
1. Write exactly ONE read-only query (SELECT or WITH ... SELECT). Never modify data.
2. Use only the tables and columns above. Wrap every column and table name in double quotes, e.g. "Order Date".
3. Use DuckDB syntax: date_trunc('month', d), strftime(d, '%Y-%m'), extract(year FROM d), d - INTERVAL 30 DAY,
   ILIKE for case-insensitive text matching, round(x, 2), try_cast(x AS DOUBLE), QUALIFY for window filters.
4. Match text values exactly as listed in the schema's "values" lists. If no list is given, use ILIKE '%term%'.
5. Give result columns short, human-readable aliases (e.g. AS "Total revenue").
6. For rankings, ORDER BY the metric and LIMIT to a sensible number (default 10). Otherwise LIMIT 500.
7. For trends over time, group by a truncated date and ORDER BY it ascending.
8. If the question cannot be answered from these tables, set "sql" to "" and say why in "explanation".

Respond with JSON only:
{"sql": "...", "title": "short title for the result", "explanation": "one sentence describing what the query does",
 "chart": {"type": "bar|line|pie|scatter|none", "x": "category or date column alias", "y": ["numeric column alias", ...]}}
Choose "line" for time series, "bar" for comparing categories, "pie" only for parts of a whole with ≤ 6 slices,
"scatter" for two numeric measures, and "none" for single values or wide tables.`;
}

export interface HistoryTurn {
  question: string;
  sql?: string;
}

export function sqlMessages(schema: string, question: string, history: HistoryTurn[], today: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: sqlSystemPrompt(schema, today) }];
  for (const turn of history.slice(-4)) {
    if (!turn.sql) continue;
    messages.push({ role: 'user', content: turn.question });
    messages.push({ role: 'assistant', content: JSON.stringify({ sql: turn.sql }) });
  }
  messages.push({ role: 'user', content: question });
  return messages;
}

export function repairMessage(sql: string, error: string): ChatMessage[] {
  return [
    { role: 'assistant', content: JSON.stringify({ sql }) },
    {
      role: 'user',
      content: `That query failed with this error:\n${error}\n\nFix the query. Check table and column names against the schema and quote them with double quotes. Respond with the full JSON again.`,
    },
  ];
}

export function summaryMessages(question: string, sql: string, result: QueryResult): ChatMessage[] {
  const header = result.columns.map((c) => c.name);
  const shown = result.rows.slice(0, 40);
  const csv = rowsToCsv(header, shown.map((r) => header.map((h) => r[h])));
  const more = result.rows.length > shown.length || result.truncated ? `\n(${result.truncated ? 'more than ' : ''}${result.rows.length} rows in total; first ${shown.length} shown)` : '';
  return [
    {
      role: 'system',
      content:
        'You explain data analysis results to busy, non-technical professionals (accountants, clinic managers, HR and finance staff). ' +
        'Answer the question directly in 1-3 short sentences, quoting the key numbers with thousands separators. ' +
        'Only use numbers that appear in the result. Do not mention SQL, queries or tables. No preamble, no markdown headings.',
    },
    { role: 'user', content: `Question: ${question}\n\nQuery used:\n${sql}\n\nResult:\n${csv}${more}` },
  ];
}

/** Extract the plan JSON from a model reply, tolerating code fences or chatter around it. */
export function parsePlan(reply: string): PlanJson {
  let text = reply.trim();
  const fence = /```(?:json|sql)?\s*([\s\S]*?)```/i.exec(text);
  if (fence) text = fence[1].trim();
  let obj: any = null;
  try {
    obj = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        obj = JSON.parse(text.slice(start, end + 1));
      } catch {
        obj = null;
      }
    }
  }
  if (!obj || typeof obj !== 'object') {
    // Some models ignore the JSON instruction and reply with bare SQL.
    if (/^\s*(select|with|from)\b/i.test(text)) obj = { sql: text };
    else throw new Error('The model did not return a valid answer. Try rephrasing the question or choosing a stronger model.');
  }
  const chart = obj.chart && typeof obj.chart === 'object' ? obj.chart : { type: 'none' };
  return {
    sql: typeof obj.sql === 'string' ? obj.sql.trim() : '',
    title: typeof obj.title === 'string' ? obj.title : '',
    explanation: typeof obj.explanation === 'string' ? obj.explanation : '',
    chart: {
      type: typeof chart.type === 'string' ? chart.type : 'none',
      x: typeof chart.x === 'string' ? chart.x : undefined,
      y: Array.isArray(chart.y) ? chart.y.filter((v: unknown) => typeof v === 'string') : typeof chart.y === 'string' ? [chart.y] : undefined,
    },
  };
}
