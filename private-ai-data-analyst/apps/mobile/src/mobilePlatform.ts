import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import {
  DEFAULT_SETTINGS,
  LICENSE_PUBLIC_KEY_HEX,
  OllamaClient,
  canAsk,
  evaluateLicense,
  hostAllowed,
  type FetchLike,
  type LicenseState,
  type Settings,
} from '@pada/core';
import type { PlatformApi } from '@pada/ui';
import type { WasmEngine } from './wasmEngine';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

/**
 * On a device, model requests go through Capacitor's native HTTP layer: no browser CORS setup is needed
 * on the Ollama machine, and the WebView itself keeps a CSP that forbids all network access.
 */
const nativeFetch: FetchLike = async (url, init = {}) => {
  const res = await CapacitorHttp.request({
    url,
    method: init.method ?? 'GET',
    headers: init.headers,
    data: init.body ? JSON.parse(init.body) : undefined,
    connectTimeout: 8000,
    readTimeout: 180_000,
  });
  const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text: async () => text, json: async () => (typeof res.data === 'string' ? JSON.parse(res.data) : res.data) };
};

const MOBILE_DEFAULTS: Settings = { ...DEFAULT_SETTINGS, ollamaUrl: '', maxRows: 2000 };

export function createMobilePlatform(engine: WasmEngine): PlatformApi {
  const settings = () => store.get<Settings>('pada.settings', MOBILE_DEFAULTS);
  const licenseFile = () => {
    const file = store.get<{ key: string | null; firstRun: string }>('pada.license', { key: null, firstRun: '' });
    if (!file.firstRun) {
      file.firstRun = new Date().toISOString();
      store.set('pada.license', file);
    }
    return file;
  };
  const licenseState = (key = licenseFile().key): LicenseState =>
    evaluateLicense(key, { publicKeyHex: LICENSE_PUBLIC_KEY_HEX, buildDate: __BUILD_DATE__, firstRun: licenseFile().firstRun });
  const client = () => {
    const s = settings();
    if (!s.ollamaUrl) throw new Error('Enter the address of the computer running Ollama in Settings.');
    const allowed = hostAllowed(s.ollamaUrl, s.allowNonPrivateHost);
    if (!allowed.ok) throw new Error(allowed.reason);
    return new OllamaClient(s.ollamaUrl, Capacitor.isNativePlatform() ? nativeFetch : undefined);
  };

  return {
    kind: 'mobile',
    info: async () => ({ version: __APP_VERSION__, buildDate: __BUILD_DATE__, platform: Capacitor.getPlatform() }),
    pickAndImport: async () => null, // The UI uses a native <input type="file"> on mobile.
    importDropped: (files) => engine.importFiles(files),
    listTables: () => engine.workspace.listTables(),
    dropTable: (name) => engine.workspace.drop(name),
    preview: (name) => engine.workspace.preview(name),
    runUntrusted: (sql, maxRows) => engine.workspace.runUntrusted(sql, maxRows),
    llmModels: () => client().listModels(),
    llmChat: async (req) => {
      if (!canAsk(licenseState())) throw new Error('A licence is required to ask new questions.');
      return client().chat(req);
    },
    getSettings: async () => settings(),
    saveSettings: async (s) => {
      const next = { ...settings(), ...s };
      store.set('pada.settings', next);
      return next;
    },
    getLicense: async () => licenseState(),
    activateLicense: async (key) => {
      const state = licenseState(key);
      if (state.status === 'licensed' || state.status === 'updates-expired') store.set('pada.license', { ...licenseFile(), key: key.trim() });
      return state;
    },
    removeLicense: async () => {
      store.set('pada.license', { ...licenseFile(), key: null });
      return licenseState(null);
    },
    saveFile: async (name, content, mime) => {
      if (Capacitor.isNativePlatform()) {
        const file = await Filesystem.writeFile({ path: name, data: content, directory: Directory.Cache, encoding: Encoding.UTF8 });
        await Share.share({ title: name, url: file.uri });
        return true;
      }
      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      const a = Object.assign(document.createElement('a'), { href: url, download: name });
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    },
    openExternal: async () => undefined,
  };
}
