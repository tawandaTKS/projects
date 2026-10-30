import { contextBridge, ipcRenderer, webUtils } from 'electron';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

// A narrow, typed bridge. The renderer has no Node.js access and no network access.
contextBridge.exposeInMainWorld('pada', {
  info: () => invoke('app:info'),
  pickAndImport: () => invoke('files:pick'),
  importPaths: (paths: string[]) => invoke('files:import', paths),
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  listTables: () => invoke('tables:list'),
  dropTable: (name: string) => invoke('tables:drop', name),
  preview: (name: string) => invoke('tables:preview', name),
  runUntrusted: (sql: string, maxRows: number) => invoke('sql:runUntrusted', sql, maxRows),
  llmChat: (req: unknown) => invoke('llm:chat', req),
  llmModels: () => invoke('llm:models'),
  getSettings: () => invoke('settings:get'),
  saveSettings: (s: unknown) => invoke('settings:set', s),
  getLicense: () => invoke('license:get'),
  activateLicense: (key: string) => invoke('license:activate', key),
  removeLicense: () => invoke('license:remove'),
  saveFile: (name: string, content: string) => invoke('file:save', name, content),
  openExternal: (url: string) => invoke('shell:openExternal', url),
});
