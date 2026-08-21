import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { Database } from 'bun:sqlite';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture } from '../src/db/index.js';
import {
  encodeCanonicalCaptureBytes,
  readStoredCaptureBytes,
} from '../src/capture/canonical.js';
import { migrateCaptureStorage } from '../src/db/storage-migration.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});

afterEach(() => db.close());

const HTML = Buffer.from(`<!doctype html><html><body>${'Compressible archive body. '.repeat(500)}</body></html>`);
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function capture(bytes: Buffer, compression: 'none' | 'gzip' | 'zstd', contentHash = hash(HTML)): number {
  const url = getOrCreateUrl(db, `https://example.com/${compression}-${Math.random()}`, `https://example.com/${compression}`);
  return insertCapture(db, {
    url_id: url.id,
    source_url: url.original,
    final_url: url.original,
    html: bytes,
    compression,
    content_hash: contentHash,
    html_size: HTML.byteLength,
    title: compression,
    author: null,
    site_name: null,
    published_at: null,
    excerpt: null,
    lang: null,
    extracted_text: 'body',
    mode: 'article',
    status: 'succeeded',
    capture_tool: 'test/0',
    warnings: null,
  });
}

describe('mixed capture-body compression', () => {
  test('none, gzip and zstd decode to identical canonical bytes', async () => {
    const gzip = Bun.gzipSync(HTML);
    const zstd = await Bun.zstdCompress(HTML);
    for (const row of [
      { html: HTML, compression: 'none' },
      { html: gzip, compression: 'gzip' },
      { html: zstd, compression: 'zstd' },
    ]) expect(readStoredCaptureBytes(row)).toEqual(HTML);
  });

  test('rejects unknown compression markers instead of treating them as raw bytes', () => {
    expect(() => readStoredCaptureBytes({ html: HTML, compression: 'brotli' })).toThrow('Unsupported capture compression');
  });

  test('automatic writes retain zstd only when it is strictly smaller', async () => {
    const compressed = await encodeCanonicalCaptureBytes(HTML, 'auto');
    expect(compressed.compression).toBe('zstd');
    expect(compressed.bytes.byteLength).toBeLessThan(HTML.byteLength);
    expect(readStoredCaptureBytes({ html: compressed.bytes, compression: compressed.compression })).toEqual(HTML);

    const tiny = Buffer.from('x');
    const retained = await encodeCanonicalCaptureBytes(tiny, 'auto');
    expect(retained).toEqual({ bytes: tiny, compression: 'none' });
  });
});

describe('capture-body storage migration', () => {
  test('changes only rows where verified zstd is smaller than the current BLOB', async () => {
    const none = capture(HTML, 'none');
    const gzipBytes = Buffer.from(Bun.gzipSync(HTML));
    const gzip = capture(gzipBytes, 'gzip');
    const zstdBytes = Buffer.from(await Bun.zstdCompress(HTML));
    const zstd = capture(zstdBytes, 'zstd');

    const report = await migrateCaptureStorage(db);
    expect(report.ok).toBe(true);
    expect(report.scanned).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.changed).toBeGreaterThanOrEqual(1);
    expect(report.pending).toBe(0);
    expect(db.query<{ compression: string }, [number]>('SELECT compression FROM captures WHERE id=?').get(none)?.compression).toBe('zstd');
    expect(db.query<{ compression: string; html: Uint8Array }, [number]>('SELECT compression,html FROM captures WHERE id=?').get(gzip)?.compression).toBe(
      zstdBytes.byteLength < gzipBytes.byteLength ? 'zstd' : 'gzip',
    );
    expect(db.query<{ compression: string }, [number]>('SELECT compression FROM captures WHERE id=?').get(zstd)?.compression).toBe('zstd');
  });

  test('dry-run and limit make rehearsal bounded without writes', async () => {
    const first = capture(HTML, 'none');
    capture(HTML, 'none');
    const before = Buffer.from(db.query<{ html: Uint8Array }, [number]>('SELECT html FROM captures WHERE id=?').get(first)!.html);
    const report = await migrateCaptureStorage(db, { dryRun: true, limit: 1 });
    expect(report.scanned).toBe(1);
    expect(report.wouldChange).toBe(1);
    expect(report.changed).toBe(0);
    expect(Buffer.from(db.query<{ html: Uint8Array }, [number]>('SELECT html FROM captures WHERE id=?').get(first)!.html)).toEqual(before);
  });

  test('refuses a hash mismatch and continues safely with later rows', async () => {
    const bad = capture(HTML, 'none', '0'.repeat(64));
    const good = capture(HTML, 'none');
    const report = await migrateCaptureStorage(db);
    expect(report.ok).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.failures[0].id).toBe(bad);
    expect(db.query<{ compression: string }, [number]>('SELECT compression FROM captures WHERE id=?').get(bad)?.compression).toBe('none');
    expect(db.query<{ compression: string }, [number]>('SELECT compression FROM captures WHERE id=?').get(good)?.compression).toBe('zstd');
  });

  test('bounded runs checkpoint failures and advance to later rows', async () => {
    const bad = capture(HTML, 'none', '0'.repeat(64));
    const good = capture(HTML, 'none');
    const first = await migrateCaptureStorage(db, { limit: 1 });
    const second = await migrateCaptureStorage(db, { limit: 1 });
    const third = await migrateCaptureStorage(db, { limit: 1 });
    expect(first.failed).toBe(1);
    expect(first.pending).toBe(1);
    expect(second.changed).toBe(1);
    expect(second.pending).toBe(0);
    expect(third.scanned).toBe(0);
    expect(third.ok).toBe(false);
    expect(third.failed).toBe(1);
    expect(third.failures[0].id).toBe(bad);
    expect(db.query<{ outcome: string }, [number]>('SELECT outcome FROM capture_storage_migrations WHERE capture_id=?').get(bad)?.outcome).toBe('failed');
    expect(db.query<{ compression: string }, [number]>('SELECT compression FROM captures WHERE id=?').get(good)?.compression).toBe('zstd');
  });

  test('repeated bounded runs advance and finish idempotently', async () => {
    capture(HTML, 'none');
    capture(HTML, 'none');
    const first = await migrateCaptureStorage(db, { limit: 1 });
    const second = await migrateCaptureStorage(db, { limit: 1 });
    const third = await migrateCaptureStorage(db, { limit: 1 });
    expect(first.changed).toBe(1);
    expect(first.pending).toBe(1);
    expect(second.changed).toBe(1);
    expect(second.pending).toBe(0);
    expect(second.resumed).toBe(1);
    expect(third.scanned).toBe(0);
    expect(third.changed).toBe(0);
    expect(third.resumed).toBe(2);
    expect(third.pending).toBe(0);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM capture_storage_migrations').get()?.n).toBe(2);
  });
});
