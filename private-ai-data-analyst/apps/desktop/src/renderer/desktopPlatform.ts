import type { PlatformApi } from '@pada/ui';

interface Bridge extends Omit<PlatformApi, 'kind' | 'importDropped'> {
  importPaths(paths: string[]): ReturnType<PlatformApi['importDropped']>;
  pathForFile(file: File): string;
}

declare global {
  interface Window {
    pada: Bridge;
  }
}

/** Electron IPC errors arrive as "Error invoking remote method 'x': Error: message" — keep only the message. */
function clean<T extends (...args: any[]) => Promise<any>>(fn: T): T {
  return (async (...args: any[]) => {
    try {
      return await fn(...args);
    } catch (e) {
      throw new Error(String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  }) as T;
}

export function createDesktopPlatform(): PlatformApi {
  const b = window.pada;
  return {
    kind: 'desktop',
    info: clean(b.info),
    pickAndImport: clean(b.pickAndImport),
    importDropped: clean(async (files: File[]) => b.importPaths(files.map((f) => b.pathForFile(f)).filter(Boolean))),
    listTables: clean(b.listTables),
    dropTable: clean(b.dropTable),
    preview: clean(b.preview),
    runUntrusted: clean(b.runUntrusted),
    llmChat: clean(b.llmChat),
    llmModels: clean(b.llmModels),
    getSettings: clean(b.getSettings),
    saveSettings: clean(b.saveSettings),
    getLicense: clean(b.getLicense),
    activateLicense: clean(b.activateLicense),
    removeLicense: clean(b.removeLicense),
    saveFile: clean(b.saveFile),
    openExternal: clean(b.openExternal),
  };
}
