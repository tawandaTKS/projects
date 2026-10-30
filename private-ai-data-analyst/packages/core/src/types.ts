/** Shared types used by the desktop (Electron + native DuckDB) and mobile (Capacitor + DuckDB-WASM) apps. */

export interface ColumnProfile {
  name: string;
  type: string;
  /** Distinct values for low-cardinality text columns (helps the model write correct WHERE clauses). */
  values?: string[];
  min?: string;
  max?: string;
  nulls?: number;
}

export interface TableInfo {
  name: string;
  sourceFile: string;
  sheet?: string;
  rowCount: number;
  columns: ColumnProfile[];
  sampleRows: Record<string, unknown>[];
  importedAt: string;
}

export interface ResultColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: ResultColumn[];
  rows: Record<string, unknown>[];
  /** True when more rows existed than were read. */
  truncated: boolean;
  elapsedMs: number;
}

/** Executes SQL against the local DuckDB database. Implemented per platform. */
export interface SqlRunner {
  run(sql: string, maxRows?: number): Promise<QueryResult>;
}

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'none';

export interface ChartSpec {
  type: ChartType;
  x?: string;
  y?: string[];
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  /** 'json' or a JSON schema object (Ollama structured outputs). */
  format?: 'json' | Record<string, unknown>;
  temperature?: number;
  numCtx?: number;
}

export interface ModelInfo {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
}

export interface LlmClient {
  chat(req: ChatRequest): Promise<string>;
  listModels(): Promise<ModelInfo[]>;
}

export interface Settings {
  ollamaUrl: string;
  model: string;
  /** Send 3 sample rows per table to the local model. Improves accuracy; never leaves the device/LAN. */
  includeSampleRows: boolean;
  /** Ask the model to explain the result in plain English after running the query. */
  summarize: boolean;
  /** Allow an Ollama server outside loopback / private LAN ranges. Off by default. */
  allowNonPrivateHost: boolean;
  maxRows: number;
}

export const DEFAULT_SETTINGS: Settings = {
  ollamaUrl: 'http://127.0.0.1:11434',
  model: '',
  includeSampleRows: true,
  summarize: true,
  allowNonPrivateHost: false,
  maxRows: 5000,
};

export interface ImportedTable {
  table: string;
  sourceFile: string;
  sheet?: string;
  rowCount: number;
}

export interface ImportReport {
  imported: ImportedTable[];
  errors: { file: string; message: string }[];
}
