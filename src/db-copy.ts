/**
 * Helper salin schema + data antar client libSQL (remote → remote).
 * Port dari sqlite/scripts/db-copy.ts (repo mandiri, tanpa coupling path).
 */
import { type Client, type InArgs, type ResultSet, type Row } from '@libsql/client';

export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`nama objek tidak aman: ${name}`);
  }
  return `"${name}"`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Turso / sqld rate limit atau transient. */
export function isRetryableHttpError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b429\b/.test(msg) ||
    /\b503\b/.test(msg) ||
    /\b502\b/.test(msg) ||
    /rate.?limit/i.test(msg) ||
    /too many requests/i.test(msg)
  );
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 8;
  const baseMs = opts.baseMs ?? 1000;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (!isRetryableHttpError(e) || attempt === retries) throw e;
      const wait = Math.min(baseMs * 2 ** attempt, 60_000);
      console.warn(
        `[retry] ${label} attempt ${attempt + 1}/${retries + 1} → tunggu ${wait}ms (${e instanceof Error ? e.message : e})`,
      );
      await sleep(wait);
    }
  }
  throw last;
}

export type InsertManyOpts = {
  batchSize?: number;
  pauseMs?: number;
};

export async function insertMany(
  client: Client,
  sql: string,
  rows: InArgs[],
  opts: InsertManyOpts = {},
): Promise<void> {
  if (rows.length === 0) return;
  const batchSize = opts.batchSize ?? 200;
  const pauseMs = opts.pauseMs ?? 0;
  for (const part of chunk(
    rows.map((args) => ({ sql, args })),
    batchSize,
  )) {
    await withRetry('batch write', () => client.batch(part, 'write'));
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

async function runSql(client: Client, sql: string, label: string): Promise<ResultSet> {
  return withRetry(label, () => client.execute(sql));
}

export function labelFromUrl(url: string): string {
  const host =
    url.replace(/^libsql:\/\//, '').replace(/^https:\/\//, '').replace(/^http:\/\//, '').split('/')[0] ??
    '';
  const first = host.split('.')[0] ?? 'database';
  const trimmed = first.replace(/-[a-z0-9]{6,}$/i, '');
  return trimmed || first || 'database';
}

/** Host tanpa skema, untuk bandingkan source vs dest. */
export function hostFromUrl(url: string): string {
  return (
    url
      .replace(/^libsql:\/\//, '')
      .replace(/^https:\/\//, '')
      .replace(/^http:\/\//, '')
      .split('/')[0]
      ?.toLowerCase() ?? ''
  );
}

export type MasterRow = {
  type: string;
  name: string;
  sql: string;
};

export async function fetchMasterObjects(source: Client): Promise<{
  rows: MasterRow[];
  vtabs: string[];
  shadows: Set<string>;
}> {
  const master = await runSql(
    source,
    `SELECT type, name, tbl_name, sql
     FROM sqlite_master
     WHERE sql IS NOT NULL
       AND name NOT LIKE 'sqlite_%'
     ORDER BY
       CASE type
         WHEN 'table' THEN 0
         WHEN 'index' THEN 1
         WHEN 'view' THEN 2
         WHEN 'trigger' THEN 3
         ELSE 4
       END,
       name`,
    'sqlite_master',
  );

  const rows: MasterRow[] = master.rows.map((r) => ({
    type: String(r.type),
    name: String(r.name),
    sql: String(r.sql),
  }));

  const vtabs = rows
    .filter((r) => r.type === 'table' && r.sql.startsWith('CREATE VIRTUAL'))
    .map((r) => r.name);
  const shadows = new Set(
    vtabs.flatMap((v) => ['config', 'content', 'data', 'docsize', 'idx'].map((s) => `${v}_${s}`)),
  );

  return { rows, vtabs, shadows };
}

export type CopyResult = {
  tableCount: number;
  rowCounts: Record<string, number>;
};

export type CopyOpts = {
  logPrefix?: string;
  batchSize?: number;
  pauseMs?: number;
};

/**
 * Salin semua objek user dari source ke dest (dest harus kosong / sudah di-wipe).
 */
export async function copySchemaAndData(
  source: Client,
  dest: Client,
  logPrefixOrOpts: string | CopyOpts = '[db-copy]',
): Promise<CopyResult> {
  const opts: CopyOpts =
    typeof logPrefixOrOpts === 'string' ? { logPrefix: logPrefixOrOpts } : logPrefixOrOpts;
  const logPrefix = opts.logPrefix ?? '[db-copy]';
  const insertOpts: InsertManyOpts = {
    batchSize: opts.batchSize ?? 200,
    pauseMs: opts.pauseMs ?? 0,
  };

  await runSql(dest, 'PRAGMA foreign_keys = OFF', 'pragma fk off');

  const { rows, vtabs, shadows } = await fetchMasterObjects(source);
  const tables: string[] = [];
  const rowCounts: Record<string, number> = {};

  for (const row of rows) {
    if (row.type === 'table' && !shadows.has(row.name)) {
      await runSql(dest, row.sql, `CREATE ${row.name}`);
      tables.push(row.name);
    }
  }

  for (const table of tables) {
    const q = quoteIdent(table);
    if (vtabs.includes(table)) {
      const data = await runSql(source, `SELECT * FROM ${q}`, `SELECT ${table}`);
      const insertRows: InArgs[] = data.rows.map((r: Row) => Object.values(r) as InArgs);
      await insertMany(
        dest,
        `INSERT INTO ${q} VALUES (${data.columns.map(() => '?').join(', ')})`,
        insertRows,
        insertOpts,
      );
      rowCounts[table] = insertRows.length;
      console.log(`${logPrefix} ${table}: ${insertRows.length} rows`);
      continue;
    }

    const colsInfo = await runSql(source, `PRAGMA table_info(${q})`, `pragma ${table}`);
    const colNames = colsInfo.rows.map((r) => String(r.name));
    if (colNames.length === 0) {
      rowCounts[table] = 0;
      continue;
    }

    const colList = colNames.map(quoteIdent).join(', ');
    const placeholders = colNames.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${q} (${colList}) VALUES (${placeholders})`;

    const data = await runSql(source, `SELECT ${colList} FROM ${q}`, `SELECT ${table}`);
    const insertRows: InArgs[] = data.rows.map((r: Row) =>
      colNames.map((c) => r[c] as string | number | null | Uint8Array | bigint),
    );
    await insertMany(dest, insertSql, insertRows, insertOpts);
    rowCounts[table] = insertRows.length;
    console.log(`${logPrefix} ${table}: ${insertRows.length} rows`);
  }

  for (const row of rows) {
    if (row.type === 'table') continue;
    try {
      await runSql(dest, row.sql, `CREATE ${row.type} ${row.name}`);
    } catch (e) {
      console.warn(
        `${logPrefix} skip ${row.type} ${row.name}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }

  return { tableCount: tables.length, rowCounts };
}

/**
 * Hapus semua objek user di dest (trigger → view → index → table).
 */
export async function wipeUserObjects(dest: Client, logPrefix = '[db-wipe]'): Promise<number> {
  await runSql(dest, 'PRAGMA foreign_keys = OFF', 'pragma fk off');

  const master = await runSql(
    dest,
    `SELECT type, name
     FROM sqlite_master
     WHERE name NOT LIKE 'sqlite_%'
     ORDER BY
       CASE type
         WHEN 'trigger' THEN 0
         WHEN 'view' THEN 1
         WHEN 'index' THEN 2
         WHEN 'table' THEN 3
         ELSE 4
       END,
       name`,
    'dest sqlite_master',
  );

  let dropped = 0;
  for (const row of master.rows) {
    const type = String(row.type);
    const name = String(row.name);
    const q = quoteIdent(name);
    let sql: string | null = null;
    if (type === 'trigger') sql = `DROP TRIGGER IF EXISTS ${q}`;
    else if (type === 'view') sql = `DROP VIEW IF EXISTS ${q}`;
    else if (type === 'index') sql = `DROP INDEX IF EXISTS ${q}`;
    else if (type === 'table') sql = `DROP TABLE IF EXISTS ${q}`;
    if (!sql) continue;
    try {
      await runSql(dest, sql, `DROP ${type} ${name}`);
      dropped += 1;
      console.log(`${logPrefix} dropped ${type} ${name}`);
    } catch (e) {
      console.warn(
        `${logPrefix} gagal drop ${type} ${name}: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
  return dropped;
}
