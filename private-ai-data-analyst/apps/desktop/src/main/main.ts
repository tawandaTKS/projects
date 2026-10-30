import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  LICENSE_PUBLIC_KEY_HEX,
  OllamaClient,
  SUPPORTED_EXTENSIONS,
  canAsk,
  evaluateLicense,
  hostAllowed,
  type ChatRequest,
  type LicenseState,
  type Settings,
} from '@pada/core';
import { DesktopEngine } from './engine';

declare const __APP_VERSION__: string;
declare const __BUILD_DATE__: string;

const DEV_SERVER = process.env.VITE_DEV_SERVER_URL;
const ALLOWED_EXTERNAL = new Set(['https://ollama.com/download', 'https://ollama.com/library']);

// Lets automated tests (and IT admins) point the app at an isolated data folder.
if (process.env.PADA_USER_DATA) app.setPath('userData', process.env.PADA_USER_DATA);

let engine: DesktopEngine;
let mainWindow: BrowserWindow | null = null;

const userFile = (name: string) => join(app.getPath('userData'), name);

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...JSON.parse(await readFile(userFile(name), 'utf8')) };
  } catch {
    return fallback;
  }
}

async function writeJson(name: string, value: unknown): Promise<void> {
  await writeFile(userFile(name), JSON.stringify(value, null, 2), { mode: 0o600 });
}

const getSettings = () => readJson<Settings>('settings.json', DEFAULT_SETTINGS);

interface LicenseFile {
  key: string | null;
  firstRun: string;
}

async function licenseFile(): Promise<LicenseFile> {
  const file = await readJson<LicenseFile>('license.json', { key: null, firstRun: '' });
  if (!file.firstRun) {
    file.firstRun = new Date().toISOString();
    await writeJson('license.json', file);
  }
  return file;
}

async function licenseState(): Promise<LicenseState> {
  const file = await licenseFile();
  return evaluateLicense(file.key, { publicKeyHex: LICENSE_PUBLIC_KEY_HEX, buildDate: __BUILD_DATE__, firstRun: file.firstRun });
}

async function llmClient(): Promise<OllamaClient> {
  const settings = await getSettings();
  const allowed = hostAllowed(settings.ollamaUrl, settings.allowNonPrivateHost);
  if (!allowed.ok) throw new Error(allowed.reason);
  return new OllamaClient(settings.ollamaUrl);
}

/**
 * Privacy lockdown: the renderer may not make any network request. The only outbound traffic this app
 * ever makes is the main process calling the Ollama URL configured by the user (localhost by default).
 */
function lockDownNetwork(): void {
  const devOrigin = DEV_SERVER ? new URL(DEV_SERVER).origin : null;
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    const allowed = devOrigin !== null && (details.url.startsWith(devOrigin) || details.url.startsWith(devOrigin.replace('http', 'ws')));
    callback({ cancel: !allowed });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setSpellCheckerEnabled(false);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: 'Private Analyst',
    backgroundColor: '#0f1115',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webSecurity: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault());
  if (DEV_SERVER) void mainWindow.loadURL(DEV_SERVER);
  else void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
}

function registerIpc(): void {
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) =>
    ipcMain.handle(channel, (_event, ...args) => fn(...(args as A)));

  handle('app:info', () => ({ version: __APP_VERSION__, buildDate: __BUILD_DATE__, platform: process.platform }));

  handle('files:pick', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Add data files',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Data files', extensions: SUPPORTED_EXTENSIONS }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return engine.importFiles(res.filePaths);
  });
  handle('files:import', (paths: unknown) => {
    if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) throw new Error('Invalid paths');
    return engine.importFiles(paths);
  });

  handle('tables:list', () => engine.workspace.listTables());
  handle('tables:drop', (name: string) => engine.workspace.drop(String(name)));
  handle('tables:preview', (name: string) => engine.workspace.preview(String(name)));
  handle('sql:runUntrusted', (sql: string, maxRows: number) => engine.workspace.runUntrusted(String(sql), Math.min(Number(maxRows) || 5000, 100_000)));

  handle('llm:models', async () => (await llmClient()).listModels());
  handle('llm:chat', async (req: ChatRequest) => {
    if (!canAsk(await licenseState())) throw new Error('A licence is required to ask new questions.');
    return (await llmClient()).chat(req);
  });

  handle('settings:get', getSettings);
  handle('settings:set', async (s: Partial<Settings>) => {
    const next: Settings = { ...(await getSettings()), ...s };
    await writeJson('settings.json', next);
    return next;
  });

  handle('license:get', licenseState);
  handle('license:activate', async (key: string) => {
    const file = await licenseFile();
    const state = evaluateLicense(String(key), { publicKeyHex: LICENSE_PUBLIC_KEY_HEX, buildDate: __BUILD_DATE__, firstRun: file.firstRun });
    if (state.status === 'licensed' || state.status === 'updates-expired') await writeJson('license.json', { ...file, key: String(key).trim() });
    return state;
  });
  handle('license:remove', async () => {
    await writeJson('license.json', { ...(await licenseFile()), key: null });
    return licenseState();
  });

  handle('file:save', async (name: string, content: string) => {
    const res = await dialog.showSaveDialog(mainWindow!, { defaultPath: String(name) });
    if (res.canceled || !res.filePath) return false;
    await writeFile(res.filePath, String(content));
    return true;
  });
  handle('shell:openExternal', async (url: string) => {
    if (ALLOWED_EXTERNAL.has(url)) await shell.openExternal(url);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow?.isMinimized()) mainWindow.restore();
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    lockDownNetwork();
    await mkdir(app.getPath('userData'), { recursive: true });
    try {
      engine = await DesktopEngine.open(userFile('workspace.duckdb'));
    } catch (e) {
      dialog.showErrorBox('Private Analyst', `Could not open the local database:\n${(e as Error).message}`);
      app.quit();
      return;
    }
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
