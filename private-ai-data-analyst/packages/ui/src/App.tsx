import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  RECOMMENDED_MODELS,
  ask,
  canAsk,
  pickDefaultModel,
  resultToCsv,
  suggestQuestions,
  type Answer,
  type ImportReport,
  type LicenseState,
  type ModelInfo,
  type QueryResult,
  type Settings,
  type TableInfo,
} from '@pada/core';
import { AnswerCard, DataTable, Pending, exportName, type Stage } from './components';
import type { PlatformApi } from './platform';

interface Turn {
  id: number;
  question: string;
  stage: Stage;
  answer?: Answer;
}

type OllamaStatus = { state: 'checking' } | { state: 'ok'; models: ModelInfo[] } | { state: 'down'; message: string };

let nextId = 1;

export function App({ platform }: { platform: PlatformApi }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [license, setLicense] = useState<LicenseState | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus>({ state: 'checking' });
  const [info, setInfo] = useState({ version: '', buildDate: '', platform: '' });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialog, setDialog] = useState<null | 'settings' | 'license'>(null);
  const [preview, setPreview] = useState<{ table: TableInfo; result: QueryResult } | null>(null);
  const [drawer, setDrawer] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setToast({ kind, text });
    setTimeout(() => setToast((t) => (t?.text === text ? null : t)), kind === 'error' ? 8000 : 4000);
  }, []);

  const refreshTables = useCallback(async () => setTables(await platform.listTables()), [platform]);

  const checkOllama = useCallback(
    async (current: Settings) => {
      setOllama({ state: 'checking' });
      try {
        const models = await platform.llmModels();
        setOllama({ state: 'ok', models });
        if (!current.model || !models.some((m) => m.name === current.model)) {
          const model = pickDefaultModel(models);
          if (model) setSettings(await platform.saveSettings({ model }));
        }
      } catch (e) {
        setOllama({ state: 'down', message: (e as Error).message });
      }
    },
    [platform],
  );

  useEffect(() => {
    (async () => {
      const s = await platform.getSettings();
      setSettings(s);
      setInfo(await platform.info());
      setLicense(await platform.getLicense());
      await refreshTables();
      await checkOllama(s);
    })().catch((e) => notify('error', (e as Error).message));
  }, [platform, refreshTables, checkOllama, notify]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [turns]);

  const reportImport = useCallback(
    async (report: ImportReport | null) => {
      if (!report) return;
      await refreshTables();
      if (report.imported.length) {
        const names = report.imported.map((t) => `${t.table} (${t.rowCount.toLocaleString()} rows)`).join(', ');
        notify('ok', `Added ${names}`);
      }
      if (report.errors.length) notify('error', report.errors.map((e) => `${e.file}: ${e.message}`).join('\n'));
    },
    [refreshTables, notify],
  );

  const withImport = async (fn: () => Promise<ImportReport | null>) => {
    setImporting(true);
    try {
      await reportImport(await fn());
    } catch (e) {
      notify('error', (e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const pickFiles = () => {
    if (platform.kind === 'mobile') fileInput.current?.click();
    else void withImport(() => platform.pickAndImport());
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void withImport(() => platform.importDropped(files));
  };

  const allowed = license ? canAsk(license) : false;
  const ready = tables.length > 0 && ollama.state === 'ok' && !!settings.model && allowed;

  const submit = async (question: string, replaceId?: number) => {
    const q = question.trim();
    if (!q || busy) return;
    if (!allowed) {
      setDialog('license');
      return;
    }
    const id = replaceId ?? nextId++;
    const history = turns.filter((t) => t.id !== id && t.answer?.sql && !t.answer.error).map((t) => ({ question: t.question, sql: t.answer!.sql }));
    setTurns((ts) => (replaceId ? ts.map((t) => (t.id === id ? { id, question: q, stage: 'thinking' } : t)) : [...ts, { id, question: q, stage: 'thinking' }]));
    setInput('');
    setBusy(true);
    try {
      const answer = await ask(
        { llm: { chat: platform.llmChat, listModels: platform.llmModels }, listTables: platform.listTables, runUntrusted: platform.runUntrusted },
        {
          question: q,
          model: settings.model,
          history,
          includeSampleRows: settings.includeSampleRows,
          summarize: settings.summarize,
          maxRows: settings.maxRows,
          onStage: (stage) => setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, stage } : t))),
        },
      );
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, stage: 'done', answer } : t)));
    } catch (e) {
      const answer: Answer = { question: q, title: '', explanation: '', sql: '', chart: { type: 'none' }, attempts: 0, elapsedMs: 0, error: (e as Error).message };
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, stage: 'done', answer } : t)));
    } finally {
      setBusy(false);
    }
  };

  const exportAnswer = async (a: Answer) => {
    if (!a.result) return;
    try {
      if (await platform.saveFile(exportName(a), resultToCsv(a.result), 'text/csv')) notify('ok', 'Exported.');
    } catch (e) {
      notify('error', (e as Error).message);
    }
  };

  const openPreview = async (t: TableInfo) => {
    try {
      setPreview({ table: t, result: await platform.preview(t.name) });
    } catch (e) {
      notify('error', (e as Error).message);
    }
  };

  const removeTable = async (t: TableInfo) => {
    if (!confirm(`Remove "${t.name}" from this workspace? Your original file is not touched.`)) return;
    await platform.dropTable(t.name);
    await refreshTables();
  };

  const suggestions = useMemo(() => suggestQuestions(tables), [tables]);

  return (
    <div
      className={`app ${platform.kind}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        accept=".csv,.tsv,.txt,.xlsx,.xlsm,.parquet,.pq,.json,.jsonl,.ndjson"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          if (files.length) void withImport(() => platform.importDropped(files));
        }}
      />

      <header className="topbar">
        <button className="btn icon" aria-label="Show datasets" onClick={() => setDrawer(true)}>
          ☰
        </button>
        <Brand />
        <button className="btn icon" aria-label="Settings" onClick={() => setDialog('settings')}>
          ⚙
        </button>
      </header>

      <aside className={`sidebar ${drawer ? 'open' : ''}`}>
        <div className="sidebar-head">
          <Brand />
          <button className="btn icon close" aria-label="Close" onClick={() => setDrawer(false)}>
            ✕
          </button>
        </div>
        <PrivacyBadge kind={platform.kind} />

        <div className="section-label">
          Datasets <span className="count">{tables.length}</span>
        </div>
        <button className="btn primary block" onClick={pickFiles} disabled={importing}>
          {importing ? 'Importing…' : '+ Add files'}
        </button>
        <div className="hint">CSV, Excel, Parquet or JSON{platform.kind === 'desktop' ? ' — or drop files anywhere' : ''}</div>
        <ul className="tables">
          {tables.map((t) => (
            <TableItem key={t.name} table={t} onPreview={() => openPreview(t)} onRemove={() => removeTable(t)} onInsert={(text) => setInput((v) => (v ? v + ' ' : '') + text)} />
          ))}
        </ul>

        <div className="sidebar-foot">
          <ModelStatus status={ollama} model={settings.model} onClick={() => setDialog('settings')} />
          <LicenseChip license={license} onClick={() => setDialog('license')} />
          <button className="btn ghost block" onClick={() => setDialog('settings')}>
            Settings
          </button>
        </div>
      </aside>
      {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}

      <main className="main">
        <div className="thread">
          {ollama.state === 'down' && <OllamaSetup platform={platform} message={ollama.message} onRetry={() => checkOllama(settings)} onSettings={() => setDialog('settings')} />}
          {ollama.state === 'ok' && !ollama.models.length && (
            <div className="card notice">
              <div className="card-title">Ollama is running, but no models are installed</div>
              <p>Open a terminal and run:</p>
              <pre className="sql">ollama pull {RECOMMENDED_MODELS[0].name}</pre>
              <button className="btn" onClick={() => checkOllama(settings)}>
                Check again
              </button>
            </div>
          )}
          {license && !canAsk(license) && (
            <div className="card notice">
              <div className="card-title">{license.status === 'updates-expired' ? 'Update entitlement ended' : license.status === 'invalid' ? 'Licence problem' : 'Your free trial has ended'}</div>
              <p>{'message' in license ? license.message : 'Enter a licence key to keep asking questions. Your data and past results stay available.'}</p>
              <button className="btn primary" onClick={() => setDialog('license')}>
                Enter licence key
              </button>
            </div>
          )}

          {tables.length === 0 ? (
            <EmptyState kind={platform.kind} onPick={pickFiles} importing={importing} />
          ) : (
            turns.length === 0 && (
              <div className="welcome">
                <h1>Ask anything about your data</h1>
                <p className="muted">
                  {tables.length} dataset{tables.length > 1 ? 's' : ''} loaded · {tables.reduce((n, t) => n + t.rowCount, 0).toLocaleString()} rows · answers computed on this device
                </p>
                <div className="chips">
                  {suggestions.map((s) => (
                    <button key={s} className="chip" onClick={() => submit(s)} disabled={!ready || busy}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )
          )}

          {turns.map((t) => (
            <div className="turn" key={t.id}>
              <div className="question">{t.question}</div>
              {t.answer ? <AnswerCard answer={t.answer} onExport={exportAnswer} onRetry={() => submit(t.question, t.id)} /> : <Pending stage={t.stage} />}
            </div>
          ))}
          <div ref={threadEnd} />
        </div>

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(input);
          }}
        >
          <textarea
            value={input}
            rows={1}
            placeholder={tables.length ? 'Ask a question, e.g. "Which clients owe the most?"' : 'Add a file to get started'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit(input);
              }
            }}
            disabled={!tables.length}
            aria-label="Question"
          />
          <button className="btn primary send" type="submit" disabled={!ready || busy || !input.trim()}>
            {busy ? '…' : 'Ask'}
          </button>
        </form>
        {turns.length > 0 && (
          <div className="composer-foot">
            <button className="link" onClick={() => setTurns([])} disabled={busy}>
              New conversation
            </button>
            <span className="muted">Follow-up questions use the previous answers as context.</span>
          </div>
        )}
      </main>

      {dragging && (
        <div className="dropzone">
          <div>Drop files to analyse them privately</div>
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}
      {dialog === 'settings' && (
        <SettingsDialog
          platform={platform}
          settings={settings}
          ollama={ollama}
          info={info}
          onClose={() => setDialog(null)}
          onSave={async (s) => {
            const next = await platform.saveSettings(s);
            setSettings(next);
            await checkOllama(next);
          }}
          onRefresh={() => checkOllama(settings)}
          onLicense={() => setDialog('license')}
        />
      )}
      {dialog === 'license' && <LicenseDialog platform={platform} license={license} onClose={() => setDialog(null)} onChange={setLicense} />}
      {preview && (
        <Modal title={`${preview.table.name} — first ${preview.result.rows.length} rows`} onClose={() => setPreview(null)} wide>
          <DataTable result={preview.result} maxRows={100} />
        </Modal>
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="11" width="4" height="9" rx="1.5" fill="var(--series-1)" />
        <rect x="10" y="6" width="4" height="14" rx="1.5" fill="var(--series-3)" />
        <rect x="17" y="3" width="4" height="17" rx="1.5" fill="var(--series-1)" opacity=".6" />
      </svg>
      <span>Private Analyst</span>
    </div>
  );
}

function PrivacyBadge({ kind }: { kind: 'desktop' | 'mobile' }) {
  return (
    <div className="privacy">
      <span className="lock" aria-hidden="true">
        🔒
      </span>
      <div>
        <strong>100% on-device</strong>
        <div>{kind === 'desktop' ? 'Files and questions never leave this computer.' : 'Files never leave this phone. Questions go only to your own Ollama computer.'}</div>
      </div>
    </div>
  );
}

function TableItem({ table, onPreview, onRemove, onInsert }: { table: TableInfo; onPreview: () => void; onRemove: () => void; onInsert: (s: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="table-item">
      <button className="table-row" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className="tname">{table.name}</span>
        <span className="muted small">{table.rowCount.toLocaleString()}</span>
      </button>
      {open && (
        <div className="table-detail">
          <div className="muted small">
            {table.sourceFile}
            {table.sheet ? ` › ${table.sheet}` : ''} · {table.columns.length} columns
          </div>
          <ul className="cols">
            {table.columns.map((c) => (
              <li key={c.name}>
                <button className="col" title="Insert into question" onClick={() => onInsert(c.name)}>
                  {c.name}
                </button>
                <span className="ctype">{c.type.toLowerCase()}</span>
              </li>
            ))}
          </ul>
          <div className="row-actions">
            <button className="link" onClick={onPreview}>
              Preview
            </button>
            <button className="link danger" onClick={onRemove}>
              Remove
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ModelStatus({ status, model, onClick }: { status: OllamaStatus; model: string; onClick: () => void }) {
  const [dot, text] =
    status.state === 'checking' ? ['wait', 'Connecting to Ollama…'] : status.state === 'down' ? ['bad', 'Ollama not reachable'] : model ? ['good', model] : ['wait', 'No model selected'];
  return (
    <button className="status" onClick={onClick}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>
        <span className="muted small">Local model</span>
        <br />
        {text}
      </span>
    </button>
  );
}

function LicenseChip({ license, onClick }: { license: LicenseState | null; onClick: () => void }) {
  if (!license) return null;
  const text =
    license.status === 'licensed'
      ? `Licensed · ${license.payload.edition}`
      : license.status === 'trial'
        ? `Trial · ${license.daysLeft} day${license.daysLeft === 1 ? '' : 's'} left`
        : license.status === 'developer'
          ? 'Developer build'
          : license.status === 'updates-expired'
            ? 'Renew updates'
            : license.status === 'invalid'
              ? 'Licence invalid'
              : 'Trial ended';
  return (
    <button className={`license-chip ${canAsk(license) ? '' : 'warn'}`} onClick={onClick}>
      {text}
    </button>
  );
}

function EmptyState({ kind, onPick, importing }: { kind: 'desktop' | 'mobile'; onPick: () => void; importing: boolean }) {
  return (
    <div className="empty">
      <h1>Your private data analyst</h1>
      <p className="lead">Drop in a spreadsheet and ask questions in plain English. Everything runs on this {kind === 'desktop' ? 'computer' : 'device'} — no uploads, no cloud, no account.</p>
      <button className="btn primary big" onClick={onPick} disabled={importing}>
        {importing ? 'Importing…' : kind === 'desktop' ? 'Choose files or drop them here' : 'Choose files'}
      </button>
      <ul className="points">
        <li>
          <strong>Private by design.</strong> Files are loaded into a local DuckDB database. The AI model runs in Ollama on your own hardware.
        </li>
        <li>
          <strong>Auditable.</strong> Every answer shows the exact SQL that produced it. Queries are read-only and can only see the files you add.
        </li>
        <li>
          <strong>Fast on big files.</strong> Millions of rows in CSV, Excel, Parquet or JSON.
        </li>
      </ul>
    </div>
  );
}

function OllamaSetup({ platform, message, onRetry, onSettings }: { platform: PlatformApi; message: string; onRetry: () => void; onSettings: () => void }) {
  return (
    <div className="card notice">
      <div className="card-title">Connect a local AI model</div>
      <p className="muted">{message}</p>
      {platform.kind === 'desktop' ? (
        <ol>
          <li>
            Install Ollama (free) from{' '}
            <button className="link" onClick={() => platform.openExternal('https://ollama.com/download')}>
              ollama.com/download
            </button>
            .
          </li>
          <li>
            Open a terminal and run <code>ollama pull {RECOMMENDED_MODELS[0].name}</code>
          </li>
          <li>Come back here and press “Check again”.</li>
        </ol>
      ) : (
        <ol>
          <li>Install Ollama on a computer on the same Wi-Fi and pull a model.</li>
          <li>
            Start it so your phone can reach it: <code>OLLAMA_HOST=0.0.0.0 ollama serve</code>
          </li>
          <li>In Settings, enter that computer’s address, e.g. http://192.168.1.20:11434</li>
        </ol>
      )}
      <div className="actions">
        <button className="btn primary" onClick={onRetry}>
          Check again
        </button>
        <button className="btn ghost" onClick={onSettings}>
          Settings
        </button>
      </div>
    </div>
  );
}

function Modal({ title, children, onClose, wide }: { title: string; children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn icon" aria-label="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

function SettingsDialog(props: {
  platform: PlatformApi;
  settings: Settings;
  ollama: OllamaStatus;
  info: { version: string; buildDate: string };
  onClose: () => void;
  onSave: (s: Settings) => Promise<void>;
  onRefresh: () => void;
  onLicense: () => void;
}) {
  const [s, setS] = useState(props.settings);
  const [saving, setSaving] = useState(false);
  const models = props.ollama.state === 'ok' ? props.ollama.models : [];
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));
  return (
    <Modal title="Settings" onClose={props.onClose}>
      <label className="field">
        <span>Ollama address</span>
        <input value={s.ollamaUrl} onChange={(e) => set('ollamaUrl', e.target.value)} spellCheck={false} />
        <small>{props.platform.kind === 'desktop' ? 'Default http://127.0.0.1:11434 (this computer).' : 'The address of a computer on your network running Ollama.'}</small>
      </label>
      <label className="field">
        <span>Model</span>
        <div className="inline">
          <select value={s.model} onChange={(e) => set('model', e.target.value)}>
            {!models.some((m) => m.name === s.model) && <option value={s.model}>{s.model || 'Select a model'}</option>}
            {models.map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
                {m.parameterSize ? ` (${m.parameterSize})` : ''}
              </option>
            ))}
          </select>
          <button className="btn ghost" type="button" onClick={props.onRefresh}>
            Refresh
          </button>
        </div>
        <small>
          Recommended: {RECOMMENDED_MODELS.map((m) => m.name).join(', ')}. Install with <code>ollama pull &lt;name&gt;</code>.
        </small>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.includeSampleRows} onChange={(e) => set('includeSampleRows', e.target.checked)} />
        <span>
          Show the model 3 example rows per table
          <small>More accurate answers. The model is local, so nothing leaves your {props.platform.kind === 'desktop' ? 'computer' : 'network'} either way.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.summarize} onChange={(e) => set('summarize', e.target.checked)} />
        <span>
          Explain results in plain English
          <small>Adds a short written answer above each table. Turn off for speed on slower computers.</small>
        </span>
      </label>
      <label className="check">
        <input type="checkbox" checked={s.allowNonPrivateHost} onChange={(e) => set('allowNonPrivateHost', e.target.checked)} />
        <span>
          Allow a model server outside my private network
          <small>Off by default. Only enable this for a server your organisation controls.</small>
        </span>
      </label>
      <label className="field">
        <span>Maximum rows per answer</span>
        <input type="number" min={100} max={100000} step={100} value={s.maxRows} onChange={(e) => set('maxRows', Math.max(100, Math.min(100000, Number(e.target.value) || 5000)))} />
      </label>
      <div className="modal-actions">
        <span className="muted small">
          Version {props.info.version} · released {props.info.buildDate} ·{' '}
          <button className="link" onClick={props.onLicense}>
            Licence
          </button>
        </span>
        <button
          className="btn primary"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await props.onSave(s);
              props.onClose();
            } finally {
              setSaving(false);
            }
          }}
        >
          Save
        </button>
      </div>
    </Modal>
  );
}

function LicenseDialog({ platform, license, onClose, onChange }: { platform: PlatformApi; license: LicenseState | null; onClose: () => void; onChange: (l: LicenseState) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const activate = async () => {
    setError('');
    const state = await platform.activateLicense(key);
    if (state.status === 'invalid') setError(state.message);
    else {
      onChange(state);
      if (state.status === 'licensed') onClose();
    }
  };
  return (
    <Modal title="Licence" onClose={onClose}>
      {license?.status === 'licensed' || license?.status === 'updates-expired' ? (
        <div className="license-box">
          <div>
            <strong>{license.payload.name}</strong> · {license.payload.email}
          </div>
          <div className="muted">
            {license.payload.edition} edition · {license.payload.seats} seat{license.payload.seats > 1 ? 's' : ''} · updates until {license.payload.updatesUntil}
          </div>
          {license.status === 'updates-expired' && <p className="warn-text">{license.message}</p>}
          <button
            className="link danger"
            onClick={async () => {
              if (confirm('Remove the licence from this device?')) onChange(await platform.removeLicense());
            }}
          >
            Remove licence from this device
          </button>
        </div>
      ) : (
        <p className="muted">
          {license?.status === 'trial'
            ? `You're on the free trial — ${license.daysLeft} day${license.daysLeft === 1 ? '' : 's'} left.`
            : license?.status === 'developer'
              ? 'Developer build: licensing is disabled.'
              : 'Enter the licence key from your purchase email.'}
        </p>
      )}
      <p className="muted small">
        One-time purchase. Your licence works forever with every version released during your update period; renew any time to get newer versions. Keys are checked offline — nothing is sent anywhere.
      </p>
      <label className="field">
        <span>Licence key</span>
        <textarea rows={4} value={key} onChange={(e) => setKey(e.target.value)} placeholder="PADA1.…" spellCheck={false} />
      </label>
      {error && <p className="warn-text">{error}</p>}
      <div className="modal-actions">
        <span />
        <button className="btn primary" disabled={!key.trim()} onClick={activate}>
          Activate
        </button>
      </div>
    </Modal>
  );
}
