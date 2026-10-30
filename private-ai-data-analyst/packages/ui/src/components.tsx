import { useState } from 'react';
import { formatValue, isNumericType, resultToCsv, type Answer, type QueryResult } from '@pada/core';
import { Chart } from './Chart';

export function DataTable({ result, maxRows = 200 }: { result: QueryResult; maxRows?: number }) {
  const rows = result.rows.slice(0, maxRows);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c.name} className={isNumericType(c.type) ? 'num' : ''} title={c.type}>
                {c.name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {result.columns.map((c) => (
                <td key={c.name} className={isNumericType(c.type) ? 'num' : r[c.name] == null ? 'null' : ''}>
                  {r[c.name] == null ? '—' : formatValue(r[c.name])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(result.rows.length > rows.length || result.truncated) && (
        <div className="table-note">
          Showing {rows.length.toLocaleString()} of {result.truncated ? 'more than ' : ''}
          {result.rows.length.toLocaleString()} rows{result.truncated ? '. Export includes the first ' + result.rows.length.toLocaleString() + '.' : '. Export for all rows.'}
        </div>
      )}
    </div>
  );
}

function Kpi({ result }: { result: QueryResult }) {
  const row = result.rows[0];
  return (
    <div className="kpis">
      {result.columns.slice(0, 4).map((c) => (
        <div className="kpi" key={c.name}>
          <div className="kpi-value">{formatValue(row[c.name]) || '—'}</div>
          <div className="kpi-label">{c.name}</div>
        </div>
      ))}
    </div>
  );
}

export type Stage = 'thinking' | 'running' | 'repairing' | 'summarizing' | 'done';

const STAGE_TEXT: Record<Stage, string> = {
  thinking: 'Writing a query…',
  running: 'Running it on your computer…',
  repairing: 'Fixing the query…',
  summarizing: 'Explaining the result…',
  done: '',
};

export function Pending({ stage }: { stage: Stage }) {
  return (
    <div className="card pending" aria-live="polite">
      <span className="spinner" /> {STAGE_TEXT[stage]}
    </div>
  );
}

export function AnswerCard({ answer, onExport, onRetry }: { answer: Answer; onExport: (a: Answer) => void; onRetry: () => void }) {
  const [showSql, setShowSql] = useState(false);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [copied, setCopied] = useState(false);
  const r = answer.result;
  const singleRow = r && r.rows.length === 1 && r.columns.length <= 4;
  const hasChart = r && answer.chart.type !== 'none' && !singleRow;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(answer.sql);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  if (answer.error) {
    return (
      <div className="card error">
        <div className="card-title">{answer.title || "Couldn't answer that"}</div>
        <p>{answer.error}</p>
        <div className="actions">
          <button className="btn ghost" onClick={onRetry}>
            Try again
          </button>
          {answer.sql && (
            <button className="btn ghost" onClick={() => setShowSql((s) => !s)}>
              {showSql ? 'Hide SQL' : 'Show SQL'}
            </button>
          )}
        </div>
        {showSql && <pre className="sql">{answer.sql}</pre>}
      </div>
    );
  }

  return (
    <div className="card answer">
      {answer.title && <div className="card-title">{answer.title}</div>}
      {answer.summary && <p className="summary">{answer.summary}</p>}
      {r && singleRow && <Kpi result={r} />}
      {r && hasChart && (
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={view === 'chart'} className={view === 'chart' ? 'on' : ''} onClick={() => setView('chart')}>
            Chart
          </button>
          <button role="tab" aria-selected={view === 'table'} className={view === 'table' ? 'on' : ''} onClick={() => setView('table')}>
            Table
          </button>
        </div>
      )}
      {r && hasChart && view === 'chart' && <Chart spec={answer.chart} result={r} />}
      {r && !singleRow && (!hasChart || view === 'table') && <DataTable result={r} />}
      <div className="actions">
        <button className="btn ghost" onClick={() => setShowSql((s) => !s)}>
          {showSql ? 'Hide SQL' : 'Show SQL'}
        </button>
        <button className="btn ghost" onClick={copy}>
          {copied ? 'Copied' : 'Copy SQL'}
        </button>
        {r && r.rows.length > 0 && (
          <button className="btn ghost" onClick={() => onExport(answer)}>
            Export CSV
          </button>
        )}
        <span className="meta">
          {r ? `${r.rows.length.toLocaleString()}${r.truncated ? '+' : ''} rows · query ${r.elapsedMs} ms · ` : ''}
          {(answer.elapsedMs / 1000).toFixed(1)} s total
          {answer.attempts > 1 ? ` · fixed after ${answer.attempts - 1} retr${answer.attempts > 2 ? 'ies' : 'y'}` : ''}
        </span>
      </div>
      {showSql && (
        <>
          {answer.explanation && <p className="explain">{answer.explanation}</p>}
          <pre className="sql">{answer.sql}</pre>
        </>
      )}
    </div>
  );
}

export function exportName(answer: Answer): string {
  const base = (answer.title || answer.question).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'result';
  return `${base}.csv`;
}

export { resultToCsv };
