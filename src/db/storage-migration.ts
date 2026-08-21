import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readStoredCaptureBytes } from '../capture/canonical.js';

export interface StorageMigrationOptions {
  dryRun?: boolean;
  limit?: number;
}

export interface StorageMigrationFailure {
  id: number;
  error: string;
}

export interface StorageMigrationReport {
  ok: boolean;
  dryRun: boolean;
  limit: number | null;
  scanned: number;
  changed: number;
  wouldChange: number;
  retained: number;
  resumed: number;
  failed: number;
  pending: number;
  inputBytes: number;
  outputBytes: number;
  bytesSaved: number;
  failures: StorageMigrationFailure[];
  elapsedMs: number;
}

type StoredRow = {
  id: number;
  html: Uint8Array;
  compression: string;
  content_hash: string;
  html_size: number | null;
};

/** Re-encode capture bodies one row at a time. Every row's canonical hash is
 * checked before an atomic body+progress update. Durable per-row outcomes let
 * repeated bounded runs advance instead of revisiting the same prefix. */
export async function migrateCaptureStorage(
  db: Database,
  options: StorageMigrationOptions = {},
): Promise<StorageMigrationReport> {
  const started = performance.now();
  const limit = options.limit && options.limit > 0 ? options.limit : null;
  const dryRun = options.dryRun ?? false;
  const report: StorageMigrationReport = {
    ok: true,
    dryRun,
    limit,
    scanned: 0,
    changed: 0,
    wouldChange: 0,
    retained: 0,
    resumed: 0,
    failed: 0,
    pending: 0,
    inputBytes: 0,
    outputBytes: 0,
    bytesSaved: 0,
    failures: [],
    elapsedMs: 0,
  };
  const eligibleWhere = `c.status='succeeded' AND c.html IS NOT NULL AND c.content_hash IS NOT NULL`;
  const resumedRows = dryRun ? [] : db.query<{ id: number; outcome: string; error: string | null }, []>(`
    SELECT c.id,sm.outcome,sm.error
    FROM captures c JOIN capture_storage_migrations sm ON sm.capture_id=c.id
    WHERE ${eligibleWhere} AND sm.content_hash=c.content_hash
    ORDER BY c.id
  `).all();
  report.resumed = resumedRows.length;
  for (const row of resumedRows) {
    if (row.outcome !== 'failed') continue;
    report.failed++;
    if (report.failures.length < 100) report.failures.push({ id: row.id, error: row.error ?? 'Previously recorded storage migration failure' });
  }

  const selectionLimit = limit ?? Number.MAX_SAFE_INTEGER;
  const ids = dryRun
    ? db.query<{ id: number }, [number]>(`
        SELECT c.id FROM captures c WHERE ${eligibleWhere}
        ORDER BY c.id LIMIT ?
      `).all(selectionLimit)
    : db.query<{ id: number }, [number]>(`
        SELECT c.id FROM captures c
        LEFT JOIN capture_storage_migrations sm
          ON sm.capture_id=c.id AND sm.content_hash=c.content_hash
        WHERE ${eligibleWhere} AND sm.capture_id IS NULL
        ORDER BY c.id LIMIT ?
      `).all(selectionLimit);

  const getBody = db.query<StoredRow, [number]>(
    'SELECT id,html,compression,content_hash,html_size FROM captures WHERE id=?',
  );
  const updateBody = db.query<unknown, [Uint8Array, number]>(`
    UPDATE captures SET html=?, compression='zstd',
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE id=?
  `);
  const recordOutcome = db.query<unknown, [number, string, string, number, string, string, number, string | null]>(`
    INSERT INTO capture_storage_migrations
      (capture_id,content_hash,source_compression,source_bytes,outcome,result_compression,result_bytes,error)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(capture_id) DO UPDATE SET
      content_hash=excluded.content_hash,
      source_compression=excluded.source_compression,
      source_bytes=excluded.source_bytes,
      outcome=excluded.outcome,
      result_compression=excluded.result_compression,
      result_bytes=excluded.result_bytes,
      error=excluded.error,
      processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `);

  for (const { id } of ids) {
    report.scanned++;
    try {
      const row = getBody.get(id);
      if (!row?.html || !row.content_hash) throw new Error('Capture body or content hash is missing');
      const storedBytes = Buffer.from(row.html).byteLength;
      report.inputBytes += storedBytes;
      const canonical = readStoredCaptureBytes(row);
      if (row.html_size != null && canonical.byteLength !== row.html_size) {
        throw new Error(`Canonical size mismatch: expected ${row.html_size}, got ${canonical.byteLength}`);
      }
      const actual = createHash('sha256').update(canonical).digest('hex');
      if (actual !== row.content_hash) throw new Error(`Canonical hash mismatch: expected ${row.content_hash}, got ${actual}`);

      const zstd = Buffer.from(await Bun.zstdCompress(canonical));
      const advantageous = zstd.byteLength < storedBytes;
      const resultBytes = advantageous ? zstd.byteLength : storedBytes;
      const resultCompression = advantageous ? 'zstd' : row.compression;
      report.outputBytes += resultBytes;
      if (advantageous) {
        report.wouldChange++;
        report.bytesSaved += storedBytes - zstd.byteLength;
      }
      if (dryRun) {
        if (!advantageous) report.retained++;
        continue;
      }

      db.transaction(() => {
        if (advantageous) updateBody.run(zstd, id);
        recordOutcome.run(
          id,
          row.content_hash,
          row.compression,
          storedBytes,
          advantageous ? 'changed' : 'retained',
          resultCompression,
          resultBytes,
          null,
        );
      })();
      if (advantageous) report.changed++;
      else report.retained++;
    } catch (error: any) {
      const message = String(error?.message ?? error).slice(0, 1000);
      report.failed++;
      if (report.failures.length < 100) report.failures.push({ id, error: message });
      if (!dryRun) {
        const row = getBody.get(id);
        if (row?.html && row.content_hash) {
          const storedBytes = Buffer.from(row.html).byteLength;
          db.transaction(() => recordOutcome.run(
            id,
            row.content_hash,
            row.compression,
            storedBytes,
            'failed',
            row.compression,
            storedBytes,
            message,
          ))();
        }
      }
    }
  }

  report.pending = dryRun
    ? Math.max(0, (db.query<{ n: number }, []>(`SELECT COUNT(*) n FROM captures c WHERE ${eligibleWhere}`).get()?.n ?? 0) - report.scanned)
    : db.query<{ n: number }, []>(`
        SELECT COUNT(*) n FROM captures c
        LEFT JOIN capture_storage_migrations sm
          ON sm.capture_id=c.id AND sm.content_hash=c.content_hash
        WHERE ${eligibleWhere} AND sm.capture_id IS NULL
      `).get()?.n ?? 0;
  report.ok = report.failed === 0;
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}
