/**
 * Read-only SQL guard for model-generated queries.
 *
 * Layer 1 (both platforms): a lexical check — one statement, starts with SELECT/WITH/FROM,
 * no file/URL-reading table functions, no string literals or quoted identifiers that look like
 * paths or URLs (DuckDB "replacement scans" would otherwise read `FROM '/etc/passwd'`).
 *
 * Layer 2 (desktop): `validateSelectAst` walks DuckDB's own parse tree (json_serialize_sql) and
 * only permits the user's imported tables and CTEs.
 */

export type GuardResult = { ok: true; sql: string } | { ok: false; reason: string };

const ALLOWED_START = new Set(['SELECT', 'WITH', 'FROM']);

const FORBIDDEN_FUNCTIONS =
  /\b(read_[a-z0-9_]*|[a-z0-9_]*_scan|glob|sniff_csv|parquet_[a-z_]+|query|query_table|getenv|load_extension|duckdb_secrets|which_secret|httpfs_[a-z_]*|delta_[a-z_]*|iceberg_[a-z_]*|sqlite_[a-z_]*|postgres_[a-z_]*|mysql_[a-z_]*)\s*\(/i;

const FORBIDDEN_WORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|COPY|EXPORT|IMPORT|INSTALL|LOAD|PRAGMA|CALL|CHECKPOINT|VACUUM|TRUNCATE|MERGE|GRANT|REVOKE)\s/i;

/** Looks like a filesystem path, file name or URL. */
export function looksLikeLocation(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return true; // http://, s3://, file://
  if (/^(\/|~|\.{1,2}[\\/]|[a-z]:[\\/]|\\\\)/i.test(t)) return true; // absolute / relative / UNC
  if (/\.(csv|tsv|txt|parquet|pq|json|jsonl|ndjson|xlsx|xls|db|duckdb|sqlite|gz|zst|arrow|avro)$/i.test(t)) return true;
  if (/[*?]\s*$/.test(t) && /[\\/]/.test(t)) return true; // globs
  return false;
}

interface Lexed {
  /** SQL with comments removed and literal contents replaced by placeholders. */
  masked: string;
  singleQuoted: string[];
  /** The token preceding each single-quoted literal (upper-cased), e.g. FROM, JOIN, ",". */
  singlePrev: string[];
  doubleQuoted: string[];
  statementBreak: boolean;
  unterminated: boolean;
}

function lex(sql: string): Lexed {
  let masked = '';
  const singleQuoted: string[] = [];
  const singlePrev: string[] = [];
  const doubleQuoted: string[] = [];
  const prevToken = () => (/(\w+|[^\s\w])\s*$/.exec(masked)?.[1] ?? '').toUpperCase();
  let statementBreak = false;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      masked += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) return { masked, singleQuoted, singlePrev, doubleQuoted, statementBreak, unterminated: true };
      i = end + 2;
      masked += ' ';
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let content = '';
      for (;;) {
        if (j >= sql.length) return { masked, singleQuoted, singlePrev, doubleQuoted, statementBreak, unterminated: true };
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            content += ch;
            j += 2;
            continue;
          }
          break;
        }
        content += sql[j];
        j++;
      }
      if (ch === "'") {
        singlePrev.push(prevToken());
        singleQuoted.push(content);
        masked += "'?'";
      } else {
        doubleQuoted.push(content);
        masked += '"?"';
      }
      i = j + 1;
      continue;
    }
    if (ch === '$' && /[a-z_$]/i.test(next ?? '')) {
      // Dollar-quoted strings: $$...$$ or $tag$...$tag$
      const m = /^\$([a-z_]*)\$/i.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end === -1) return { masked, singleQuoted, singlePrev, doubleQuoted, statementBreak, unterminated: true };
        singlePrev.push(prevToken());
        singleQuoted.push(sql.slice(i + tag.length, end));
        masked += "'?'";
        i = end + tag.length;
        continue;
      }
    }
    if (ch === ';') {
      if (sql.slice(i + 1).trim() !== '') statementBreak = true;
      i++;
      continue;
    }
    masked += ch;
    i++;
  }
  return { masked, singleQuoted, singlePrev, doubleQuoted, statementBreak, unterminated: false };
}

export function guardSql(input: string): GuardResult {
  const sql = input.trim().replace(/;+\s*$/, '').trim();
  if (!sql) return { ok: false, reason: 'The query is empty.' };
  if (sql.length > 20000) return { ok: false, reason: 'The query is too long.' };

  const lexed = lex(sql);
  if (lexed.unterminated) return { ok: false, reason: 'The query has an unterminated quote or comment.' };
  if (lexed.statementBreak) return { ok: false, reason: 'Only a single SQL statement is allowed.' };

  const first = lexed.masked.trim().replace(/^\(+/, '').split(/\s+/)[0]?.toUpperCase() ?? '';
  if (!ALLOWED_START.has(first)) {
    return { ok: false, reason: `Only read-only SELECT queries are allowed (got "${first}").` };
  }
  const word = FORBIDDEN_WORDS.exec(lexed.masked + ' ');
  if (word) return { ok: false, reason: `"${word[1].toUpperCase()}" is not allowed; queries must be read-only.` };

  const fn = FORBIDDEN_FUNCTIONS.exec(lexed.masked);
  if (fn) {
    return { ok: false, reason: `The function ${fn[1]}() is not allowed. Query the imported tables by name instead.` };
  }
  if (/\b(FROM|JOIN)\s*\(?\s*'\?'/i.test(lexed.masked)) {
    return { ok: false, reason: 'Reading files or URLs directly is not allowed. Use the imported table names.' };
  }
  const tableish = new Set(['FROM', 'JOIN', ',', '(']);
  if (lexed.singleQuoted.some((s, i) => tableish.has(lexed.singlePrev[i]) && looksLikeLocation(s))) {
    return { ok: false, reason: 'Reading files or URLs directly is not allowed. Use the imported table names.' };
  }
  if (lexed.doubleQuoted.some(looksLikeLocation)) {
    return { ok: false, reason: 'Quoted identifiers that look like file paths or URLs are not allowed.' };
  }
  return { ok: true, sql };
}

/* ------------------------------------------------------------------------------------------ */

const ALLOWED_TABLE_FUNCTIONS = new Set(['range', 'generate_series', 'unnest']);

export type AstCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validate the JSON produced by DuckDB's `json_serialize_sql(sql)`.
 * Every BASE_TABLE must be one of `allowedTables` or a CTE defined in the query;
 * table functions are limited to a small safe set.
 */
export function validateSelectAst(astJson: string, allowedTables: string[]): AstCheck {
  let ast: any;
  try {
    ast = JSON.parse(astJson);
  } catch {
    return { ok: false, reason: 'Could not parse the query.' };
  }
  if (ast.error) return { ok: false, reason: String(ast.error_message ?? 'Only SELECT queries are allowed.') };
  if (!Array.isArray(ast.statements) || ast.statements.length !== 1) {
    return { ok: false, reason: 'Only a single SELECT statement is allowed.' };
  }
  const allowed = new Set(allowedTables.map((t) => t.toLowerCase()));
  const ctes = new Set<string>();
  const collectCtes = (node: any): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(collectCtes);
    if (node.cte_map?.map && Array.isArray(node.cte_map.map)) {
      for (const entry of node.cte_map.map) {
        const key = entry?.key ?? entry?.first;
        if (typeof key === 'string') ctes.add(key.toLowerCase());
      }
    }
    for (const v of Object.values(node)) collectCtes(v);
  };
  collectCtes(ast.statements);

  let failure: string | null = null;
  const walk = (node: any): void => {
    if (failure || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === 'BASE_TABLE' && typeof node.table_name === 'string') {
      const name = node.table_name.toLowerCase();
      const schema = String(node.schema_name ?? '').toLowerCase();
      const catalog = String(node.catalog_name ?? '').toLowerCase();
      const qualifiedOk = (schema === '' || schema === 'main') && (catalog === '' || catalog === 'memory' || catalog === 'workspace');
      if (!qualifiedOk || !(allowed.has(name) || ctes.has(name))) {
        failure = `Unknown table "${node.table_name}". Available tables: ${allowedTables.join(', ') || '(none)'}.`;
        return;
      }
    }
    if (node.type === 'TABLE_FUNCTION') {
      const fname = String(node.function?.function_name ?? '').toLowerCase();
      if (!ALLOWED_TABLE_FUNCTIONS.has(fname)) {
        failure = `Table function ${fname}() is not allowed.`;
        return;
      }
    }
    if (node.class === 'FUNCTION' && typeof node.function_name === 'string' && FORBIDDEN_FUNCTIONS.test(node.function_name + '(')) {
      failure = `The function ${node.function_name}() is not allowed.`;
      return;
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(ast.statements);
  return failure ? { ok: false, reason: failure } : { ok: true };
}
