import type { ChartSpec, ChartType, QueryResult } from './types';
import { isNumericType, isTemporalType } from './values';

const TYPES: ChartType[] = ['bar', 'line', 'pie', 'scatter', 'none'];

/** Validate the model's chart suggestion against the actual result, falling back to a sensible default. */
export function resolveChart(suggested: { type?: string; x?: string; y?: string[] } | undefined, result: QueryResult): ChartSpec {
  const cols = result.columns;
  const n = result.rows.length;
  if (n < 2 || cols.length < 2) return { type: 'none' };
  const byName = new Map(cols.map((c) => [c.name, c]));
  const numeric = cols.filter((c) => isNumericType(c.type)).map((c) => c.name);
  if (!numeric.length) return { type: 'none' };

  const type = TYPES.includes(suggested?.type as ChartType) ? (suggested!.type as ChartType) : undefined;
  let x = suggested?.x && byName.has(suggested.x) ? suggested.x : undefined;
  let y = (suggested?.y ?? []).filter((c) => byName.has(c) && numeric.includes(c) && c !== x);

  if (type === 'none') return { type: 'none' };
  if (!x) {
    x = cols.find((c) => isTemporalType(c.type))?.name ?? cols.find((c) => !isNumericType(c.type))?.name ?? (type === 'scatter' ? numeric[0] : undefined);
  }
  if (!x) return { type: 'none' };
  if (!y.length) y = numeric.filter((c) => c !== x).slice(0, 3);
  if (!y.length) return { type: 'none' };

  const xIsTime = isTemporalType(byName.get(x)!.type) || /^(year|month|week|day|date|quarter|period)/i.test(x);
  let chosen: ChartType = type ?? (xIsTime ? 'line' : 'bar');
  if (chosen === 'pie' && (n > 8 || y.length > 1)) chosen = 'bar';
  if (chosen === 'scatter' && !numeric.includes(x)) chosen = 'bar';
  if (n > 500 && chosen === 'bar') chosen = xIsTime ? 'line' : 'none';
  return { type: chosen, x, y: chosen === 'pie' ? y.slice(0, 1) : y.slice(0, 4) };
}
