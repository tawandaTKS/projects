import ExcelJS from 'exceljs';
import { csvEscape } from './csv';

export interface SheetCsv {
  sheet: string;
  csv: string;
  rows: number;
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const iso = value.toISOString();
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/\.\d+Z$/, '');
  }
  if (typeof value === 'object') {
    const v = value as any;
    if ('result' in v) return cellToString(v.result as ExcelJS.CellValue); // formula
    if ('richText' in v) return v.richText.map((r: { text: string }) => r.text).join('');
    if ('text' in v) return String(v.text); // hyperlink
    if ('error' in v) return '';
    return '';
  }
  return String(value);
}

/**
 * Convert every non-empty worksheet to CSV (header = first non-empty row). DuckDB then infers types
 * from the CSV, which is far more reliable than per-cell Excel typing.
 */
export async function excelToCsv(data: ArrayBuffer | Uint8Array): Promise<SheetCsv[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as ArrayBuffer);
  const out: SheetCsv[] = [];
  wb.eachSheet((ws) => {
    const rows: string[][] = [];
    let width = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      const count = row.cellCount;
      for (let c = 1; c <= count; c++) cells.push(cellToString(row.getCell(c).value));
      while (cells.length && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) return;
      width = Math.max(width, cells.length);
      rows.push(cells);
    });
    if (rows.length < 2) return;
    const header = rows[0];
    const seen = new Map<string, number>();
    const names = Array.from({ length: width }, (_, i) => {
      let name = (header[i] ?? '').trim() || `column_${i + 1}`;
      const n = seen.get(name.toLowerCase()) ?? 0;
      seen.set(name.toLowerCase(), n + 1);
      if (n) name = `${name}_${n + 1}`;
      return name;
    });
    const lines = [names.map(csvEscape).join(',')];
    for (const r of rows.slice(1)) {
      const padded = Array.from({ length: width }, (_, i) => r[i] ?? '');
      lines.push(padded.map(csvEscape).join(','));
    }
    out.push({ sheet: ws.name, csv: lines.join('\n') + '\n', rows: rows.length - 1 });
  });
  return out;
}
