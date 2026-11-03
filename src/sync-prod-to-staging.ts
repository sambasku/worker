/**
 * Wipe staging lalu salin penuh dari production (HTTP libSQL).
 *
 * Env:
 *   SOURCE_DATABASE_URL / SOURCE_DATABASE_AUTH_TOKEN  (production)
 *   DEST_DATABASE_URL / DEST_DATABASE_AUTH_TOKEN      (staging)
 *
 * Flag wajib: --i-understand-dest-will-be-wiped
 *
 * Usage:
 *   pnpm sync-prod-staging -- --i-understand-dest-will-be-wiped
 */
import { createClient } from '@libsql/client';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import {
  copySchemaAndData,
  hostFromUrl,
  labelFromUrl,
  wipeUserObjects,
} from './db-copy.ts';

const WIPE_FLAG = '--i-understand-dest-will-be-wiped';

/** Dest yang diizinkan (sqld staging resmi). */
const DEST_ALLOWLIST = new Set(['db-sambasku-staging.iamutaki.com']);

/** Host production yang dilarang jadi DEST. */
const PROD_DEST_BLOCKLIST = ['data.sambasku.com', 'db-prod-sambasku'];

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} wajib`);
  return v;
}

function assertSyncGuards(sourceUrl: string, destUrl: string, argv: string[]): void {
  if (!argv.includes(WIPE_FLAG)) {
    throw new Error(
      `flag ${WIPE_FLAG} wajib. Dest akan dihapus isinya lalu diisi ulang dari source.`,
    );
  }

  const sourceHost = hostFromUrl(sourceUrl);
  const destHost = hostFromUrl(destUrl);
  if (!sourceHost || !destHost) {
    throw new Error('SOURCE_DATABASE_URL / DEST_DATABASE_URL tidak punya host yang valid');
  }
  if (sourceHost === destHost) {
    throw new Error(`source dan dest host sama (${sourceHost}) - ditolak`);
  }
  for (const blocked of PROD_DEST_BLOCKLIST) {
    if (destHost === blocked || destHost.includes(blocked)) {
      throw new Error(`DEST mengarah ke production (${destHost}) - ditolak`);
    }
  }
  if (destHost.includes('turso.io') && destHost.includes('db-prod')) {
    throw new Error(`DEST Turso production (${destHost}) - ditolak`);
  }
  if (!DEST_ALLOWLIST.has(destHost)) {
    throw new Error(
      `DEST host ${destHost} di luar allowlist staging (${[...DEST_ALLOWLIST].join(', ')})`,
    );
  }
}

export async function syncProdToStaging(): Promise<{
  sourceLabel: string;
  destHost: string;
  tableCount: number;
  dropped: number;
  totalRows: number;
  wordsCount: number;
}> {
  const sourceUrl = requireEnv('SOURCE_DATABASE_URL');
  const destUrl = requireEnv('DEST_DATABASE_URL');
  assertSyncGuards(sourceUrl, destUrl, process.argv);

  const sourceToken = process.env.SOURCE_DATABASE_AUTH_TOKEN?.trim() || undefined;
  const destToken = process.env.DEST_DATABASE_AUTH_TOKEN?.trim() || undefined;

  const source = createClient({ url: sourceUrl, authToken: sourceToken });
  const dest = createClient({ url: destUrl, authToken: destToken });

  try {
    await source.execute('SELECT 1');
    await dest.execute('SELECT 1');

    console.log(`[sync] source=${labelFromUrl(sourceUrl)} (${hostFromUrl(sourceUrl)})`);
    console.log(`[sync] dest=${hostFromUrl(destUrl)}`);
    console.log('[sync] wipe dest…');
    const dropped = await wipeUserObjects(dest, '[sync]');
    console.log(`[sync] dropped=${dropped} objek`);

    console.log('[sync] copy schema + data…');
    const result = await copySchemaAndData(source, dest, {
      logPrefix: '[sync]',
      batchSize: 50,
      pauseMs: 50,
    });

    const words = await dest.execute('SELECT COUNT(*) AS n FROM words');
    const wordsCount = Number(words.rows[0]?.n ?? 0);
    if (wordsCount < 1) {
      throw new Error('smoke gagal: words masih 0 setelah sync');
    }

    const totalRows = Object.values(result.rowCounts).reduce((a, b) => a + b, 0);
    return {
      sourceLabel: labelFromUrl(sourceUrl),
      destHost: hostFromUrl(destUrl),
      tableCount: result.tableCount,
      dropped,
      totalRows,
      wordsCount,
    };
  } finally {
    dest.close();
    source.close();
  }
}

async function main(): Promise<void> {
  const result = await syncProdToStaging();
  console.log(`SOURCE_LABEL=${result.sourceLabel}`);
  console.log(`DEST_HOST=${result.destHost}`);
  console.log(`DROPPED=${result.dropped}`);
  console.log(`TABLES=${result.tableCount}`);
  console.log(`TOTAL_ROWS=${result.totalRows}`);
  console.log(`WORDS_COUNT=${result.wordsCount}`);
  console.log('[sync] selesai');
}

const isDirect =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirect) {
  main().catch((err) => {
    console.error('[sync] gagal', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
