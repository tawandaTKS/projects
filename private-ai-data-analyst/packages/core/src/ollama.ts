import type { ChatRequest, LlmClient, ModelInfo } from './types';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<any>;
  text(): Promise<string>;
}>;

export class OllamaError extends Error {
  constructor(message: string, readonly kind: 'unreachable' | 'model' | 'http' | 'timeout') {
    super(message);
  }
}

/** Minimal client for the local Ollama REST API (https://github.com/ollama/ollama/blob/main/docs/api.md). */
export class OllamaClient implements LlmClient {
  private readonly base: string;

  constructor(baseUrl: string, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i as RequestInit), private readonly timeoutMs = 180_000) {
    this.base = baseUrl.replace(/\/+$/, '');
  }

  private async request(path: string, init: { method: string; body?: unknown }, timeoutMs = this.timeoutMs): Promise<any> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
    const timer = setTimeout(() => controller?.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.base + path, {
        method: init.method,
        headers: { 'Content-Type': 'application/json' },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: controller?.signal,
      });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new OllamaError('The local model took too long to respond.', 'timeout');
      throw new OllamaError(`Cannot reach Ollama at ${this.base}. Is Ollama running?`, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* plain text */
      }
      if (res.status === 404 && /model/i.test(message)) throw new OllamaError(message, 'model');
      throw new OllamaError(`Ollama returned ${res.status}: ${message}`, 'http');
    }
    return res.json();
  }

  async listModels(): Promise<ModelInfo[]> {
    const data = await this.request('/api/tags', { method: 'GET' }, 8000);
    return (data.models ?? []).map((m: any) => ({ name: m.name ?? m.model, sizeBytes: m.size, parameterSize: m.details?.parameter_size }));
  }

  async chat(req: ChatRequest): Promise<string> {
    const data = await this.request('/api/chat', {
      method: 'POST',
      body: {
        model: req.model,
        messages: req.messages,
        stream: false,
        format: req.format,
        keep_alive: '15m',
        options: { temperature: req.temperature ?? 0, num_ctx: req.numCtx ?? 8192 },
      },
    });
    return String(data.message?.content ?? '');
  }
}

/** Models that are known to write good DuckDB SQL, in rough order of preference. */
export const RECOMMENDED_MODELS = [
  { name: 'qwen2.5-coder:7b', note: 'Best balance of accuracy and speed (≈5 GB, 16 GB RAM)' },
  { name: 'qwen2.5-coder:14b', note: 'Most accurate on complex questions (≈9 GB, 32 GB RAM)' },
  { name: 'qwen2.5-coder:3b', note: 'For older laptops (≈2 GB, 8 GB RAM)' },
  { name: 'llama3.1:8b', note: 'Good general model, better at plain-English summaries' },
];

export function pickDefaultModel(installed: ModelInfo[]): string {
  const names = installed.map((m) => m.name);
  for (const r of RECOMMENDED_MODELS) {
    const hit = names.find((n) => n === r.name || n.startsWith(r.name.split(':')[0] + ':'));
    if (hit) return hit;
  }
  return names.find((n) => !/embed/i.test(n)) ?? '';
}
