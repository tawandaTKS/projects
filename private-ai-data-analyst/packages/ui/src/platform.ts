import type { ChatRequest, ImportReport, LicenseState, ModelInfo, QueryResult, Settings, TableInfo } from '@pada/core';

/**
 * Everything the shared UI needs from the host. Desktop implements it over Electron IPC
 * (native DuckDB in the main process); mobile implements it in-page with DuckDB-WASM.
 */
export interface PlatformApi {
  kind: 'desktop' | 'mobile';
  info(): Promise<{ version: string; buildDate: string; platform: string }>;
  /** Show a file picker and import the chosen files. Resolves null if cancelled. */
  pickAndImport(): Promise<ImportReport | null>;
  importDropped(files: File[]): Promise<ImportReport>;
  listTables(): Promise<TableInfo[]>;
  dropTable(name: string): Promise<void>;
  preview(name: string): Promise<QueryResult>;
  runUntrusted(sql: string, maxRows: number): Promise<QueryResult>;
  llmChat(req: ChatRequest): Promise<string>;
  llmModels(): Promise<ModelInfo[]>;
  getSettings(): Promise<Settings>;
  saveSettings(s: Partial<Settings>): Promise<Settings>;
  getLicense(): Promise<LicenseState>;
  activateLicense(key: string): Promise<LicenseState>;
  removeLicense(): Promise<LicenseState>;
  saveFile(name: string, content: string, mime: string): Promise<boolean>;
  openExternal(url: string): Promise<void>;
}
