import { resolveChart } from './chart';
import { OllamaError } from './ollama';
import { PLAN_SCHEMA, parsePlan, repairMessage, sqlMessages, summaryMessages, type HistoryTurn } from './prompts';
import { describeSchema } from './schema';
import type { ChartSpec, ChatMessage, LlmClient, QueryResult, TableInfo } from './types';

export type AskStage = 'thinking' | 'running' | 'repairing' | 'summarizing' | 'done';

export interface AskDeps {
  llm: LlmClient;
  listTables(): Promise<TableInfo[]>;
  runUntrusted(sql: string, maxRows: number): Promise<QueryResult>;
}

export interface AskOptions {
  question: string;
  model: string;
  history?: HistoryTurn[];
  includeSampleRows?: boolean;
  summarize?: boolean;
  maxRows?: number;
  maxAttempts?: number;
  today?: string;
  onStage?: (stage: AskStage, detail?: string) => void;
}

export interface Answer {
  question: string;
  title: string;
  explanation: string;
  sql: string;
  result?: QueryResult;
  chart: ChartSpec;
  summary?: string;
  error?: string;
  attempts: number;
  elapsedMs: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Turn a plain-English question into SQL, run it locally, self-repair on errors, and explain the result. */
export async function ask(deps: AskDeps, opts: AskOptions): Promise<Answer> {
  const started = now();
  const maxAttempts = opts.maxAttempts ?? 3;
  const stage = opts.onStage ?? (() => {});
  const base = { question: opts.question, title: '', explanation: '', sql: '', chart: { type: 'none' } as ChartSpec, attempts: 0 };
  const finish = (a: Omit<Answer, 'elapsedMs'>): Answer => {
    stage('done');
    return { ...a, elapsedMs: Math.round(now() - started) };
  };

  if (!opts.model) return finish({ ...base, error: 'Choose a local model in Settings first.' });
  const tables = await deps.listTables();
  if (!tables.length) return finish({ ...base, error: 'Add a CSV, Excel or Parquet file first.' });

  const schema = describeSchema(tables, opts.includeSampleRows ?? true);
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const messages: ChatMessage[] = sqlMessages(schema, opts.question, opts.history ?? [], today);
  const numCtx = Math.min(32768, Math.max(8192, Math.ceil((schema.length / 3 + 2500) / 1024) * 1024));

  let plan: ReturnType<typeof parsePlan> | null = null;
  let lastError = '';
  let attempts = 0;
  let result: QueryResult | undefined;

  while (attempts < maxAttempts) {
    attempts++;
    stage(attempts === 1 ? 'thinking' : 'repairing', lastError);
    let reply: string;
    try {
      reply = await deps.llm.chat({ model: opts.model, messages, format: PLAN_SCHEMA as unknown as Record<string, unknown>, temperature: 0, numCtx });
    } catch (e) {
      const msg = e instanceof OllamaError || e instanceof Error ? e.message : String(e);
      return finish({ ...base, attempts, error: msg });
    }
    try {
      plan = parsePlan(reply);
    } catch (e) {
      lastError = (e as Error).message;
      messages.push({ role: 'assistant', content: reply }, { role: 'user', content: 'Respond with valid JSON only, using the required format.' });
      continue;
    }
    if (!plan.sql) {
      return finish({ ...base, attempts, title: plan.title || 'Not answerable', explanation: plan.explanation, error: plan.explanation || 'The model could not answer this question from the loaded data.' });
    }
    stage('running');
    try {
      result = await deps.runUntrusted(plan.sql, opts.maxRows ?? 5000);
      break;
    } catch (e) {
      lastError = (e as Error).message;
      messages.push(...repairMessage(plan.sql, lastError));
    }
  }

  if (!plan || !result) {
    return finish({ ...base, attempts, sql: plan?.sql ?? '', title: plan?.title ?? '', explanation: plan?.explanation ?? '', error: `Could not produce a working query after ${attempts} attempts. Last error: ${lastError}` });
  }

  const chart = resolveChart(plan.chart, result);
  let summary: string | undefined;
  if (opts.summarize !== false && result.rows.length > 0) {
    stage('summarizing');
    try {
      summary = (await deps.llm.chat({ model: opts.model, messages: summaryMessages(opts.question, plan.sql, result), temperature: 0.2, numCtx: 8192 })).trim();
    } catch {
      summary = undefined; // The table and chart are still useful without prose.
    }
  } else if (result.rows.length === 0) {
    summary = 'No rows matched this question.';
  }

  return finish({ question: opts.question, title: plan.title, explanation: plan.explanation, sql: plan.sql, result, chart, summary, attempts });
}
