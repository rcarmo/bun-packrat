/**
 * bun-packrat — database layer
 * Opens (or creates) the SQLite database, runs pending migrations,
 * and exports typed query helpers.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CanonicalBodyFormat, CaptureBodyRow, CaptureMetadataRow, CaptureRow, JobRow, PdfSourceKind, SourcePdfMetadata, UrlRow } from '../types.js';
import { normaliseUrl } from '../capture/url.js';
import { detectStoredCaptureFormat, readStoredCaptureBytes } from '../capture/canonical.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDatabase(dbPath: string): Database {
  // Ensure the data directory exists
  const dir = dirname(dbPath);
  if (dir && dir !== '.') {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath, { create: true });

  // Enable WAL and foreign keys at connection open
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = NORMAL;');

  return db;
}

export function runMigrations(db: Database): void {
  // Ensure the migrations tracking table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
  `);

  const applied = db
    .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
    .all()
    .map((r) => r.version);

  const migrationsDir = join(__dirname, 'migrations');
  const migrations = [
    { version: 1, file: '001_initial.sql' },
    { version: 2, file: '002_constraints.sql' },
    { version: 3, file: '003_application_features.sql' },
    { version: 4, file: '004_query_indexes.sql' },
    { version: 5, file: '005_capture_body_metadata.sql' },
    { version: 6, file: '006_source_pdfs.sql' },
    { version: 7, file: '007_storage_migration_state.sql' },
  ];

  for (const { version, file } of migrations) {
    if (applied.includes(version)) continue;

    const sqlPath = join(migrationsDir, file);
    if (!existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }

    const sql = readFileSync(sqlPath, 'utf-8');

    // Each migration is atomic. Migration 3 predates conditional ADD COLUMN
    // support, so repair databases where one or more columns were added before
    // its schema_migrations row was committed.
    db.transaction(() => {
      if (version === 3) ensureApplicationFeatureColumns(db);
      if (version === 5) ensureCaptureBodyMetadata(db);
      db.exec(sql);
    })();

    console.log(`[db] Applied migration ${version}: ${file}`);
  }

  // Migration 5 may have been interrupted after its schema transaction. The
  // null predicate makes this resumable and a no-op after completion.
  if (captureColumns(db).has('body_format')) backfillCaptureBodyFormats(db);
}

function captureColumns(db: Database): Set<string> {
  return new Set(
    db.query<{ name: string }, []>('PRAGMA table_info(captures)').all().map((column) => column.name),
  );
}

function ensureApplicationFeatureColumns(db: Database): void {
  const existing = captureColumns(db);
  const columns = [
    ['error', 'TEXT'],
    ['note', 'TEXT'],
    ['capture_duration_ms', 'INTEGER'],
  ] as const;
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE captures ADD COLUMN ${name} ${type}`);
  }
}

function ensureCaptureBodyMetadata(db: Database): void {
  if (!captureColumns(db).has('body_format')) {
    db.exec('ALTER TABLE captures ADD COLUMN body_format TEXT');
  }
}

/** Classify legacy canonical bodies one row at a time. This bounds peak body
 * memory during upgrades and makes subsequent metadata requests BLOB-free. */
function backfillCaptureBodyFormats(db: Database): void {
  const ids = db.query<{ id: number }, []>(
    'SELECT id FROM captures WHERE html IS NOT NULL AND body_format IS NULL ORDER BY id',
  ).all();
  const getBody = db.query<CaptureBodyRow, [number]>(
    'SELECT html, compression FROM captures WHERE id = ?',
  );
  const update = db.query<unknown, [CanonicalBodyFormat, number]>(
    'UPDATE captures SET body_format = ? WHERE id = ?',
  );
  for (const { id } of ids) {
    const body = getBody.get(id);
    if (!body?.html) continue;
    update.run(detectStoredCaptureFormat(readStoredCaptureBytes(body)), id);
  }
}

const CAPTURE_METADATA_COLUMNS = `
  c.id, c.url_id, c.source_url, c.final_url, c.compression,
  c.content_hash, c.html_size, c.body_format,
  pb.sha256 AS source_pdf_sha256, pb.byte_size AS source_pdf_size,
  pe.status AS source_pdf_extraction_status,
  c.title, c.author, c.site_name, c.published_at, c.excerpt, c.lang,
  c.mode, c.status, c.capture_tool, c.warnings, c.error, c.note,
  c.capture_duration_ms, c.captured_at, c.created_at, c.updated_at
`;

const CAPTURE_PDF_METADATA_JOINS = `
  LEFT JOIN capture_pdfs cp ON cp.capture_id = c.id
  LEFT JOIN pdf_blobs pb ON pb.id = cp.pdf_blob_id
  LEFT JOIN pdf_extractions pe ON pe.pdf_blob_id = pb.id
`;

// ---------------------------------------------------------------------------
// Typed query helpers
// ---------------------------------------------------------------------------

export function getOrCreateUrl(
  db: Database,
  normalised: string,
  original: string,
): UrlRow {
  const domain = extractDomain(normalised);

  const existing = db
    .query<UrlRow, [string]>('SELECT * FROM urls WHERE normalised = ?')
    .get(normalised);

  if (existing) return existing;

  db.exec(
    'INSERT OR IGNORE INTO urls (normalised, original, domain) VALUES (?, ?, ?)',
    [normalised, original, domain],
  );

  return db
    .query<UrlRow, [string]>('SELECT * FROM urls WHERE normalised = ?')
    .get(normalised)!;
}

type InsertCaptureRow = Omit<CaptureRow,
  'id' | 'created_at' | 'updated_at' | 'captured_at' | 'error' | 'note' |
  'capture_duration_ms' | 'body_format' | 'source_pdf_sha256' |
  'source_pdf_size' | 'source_pdf_extraction_status'
> & {
  body_format?: CanonicalBodyFormat | null;
};

export function insertCapture(
  db: Database,
  row: InsertCaptureRow,
): number {
  const bodyFormat = row.body_format ?? inferInsertedBodyFormat(row);
  const result = db
    .query<{ id: number }, any[]>(`
      INSERT INTO captures (
        url_id, source_url, final_url, html, compression,
        content_hash, html_size, body_format, title, author, site_name,
        published_at, excerpt, lang, extracted_text,
        mode, status, capture_tool, warnings
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?
      )
      RETURNING id
    `)
    .get(
      row.url_id,
      row.source_url,
      row.final_url,
      row.html,
      row.compression,
      row.content_hash,
      row.html_size,
      bodyFormat,
      row.title,
      row.author,
      row.site_name,
      row.published_at,
      row.excerpt,
      row.lang,
      row.extracted_text,
      row.mode,
      row.status,
      row.capture_tool,
      row.warnings,
    );

  if (!result) throw new Error('INSERT captures returned no id');
  return result.id;
}

function inferInsertedBodyFormat(row: Pick<InsertCaptureRow, 'html' | 'compression'>): CanonicalBodyFormat | null {
  if (!row.html) return null;
  return detectStoredCaptureFormat(readStoredCaptureBytes(row));
}

export function updateCaptureStatus(
  db: Database,
  id: number,
  status: string,
  error?: string,
): void {
  db.exec(
    `UPDATE captures SET status = ?, error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    [status, error ?? null, id],
  );
}

export function updateLatestCapture(
  db: Database,
  urlId: number,
  captureId: number,
): void {
  db.exec(
    `UPDATE urls SET latest_capture = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
    [captureId, urlId],
  );
}

export function getCaptureById(db: Database, id: number): CaptureMetadataRow | null {
  return db
    .query<CaptureMetadataRow, [number]>(`SELECT ${CAPTURE_METADATA_COLUMNS} FROM captures c ${CAPTURE_PDF_METADATA_JOINS} WHERE c.id = ?`)
    .get(id) ?? null;
}

export interface CaptureQueryOptions {
  limit?: number;
  offset?: number;
  status?: string;
  mode?: string;
  domain?: string;
  title?: string;
  tag?: string;
  url?: string;
  dateFrom?: string;
  dateTo?: string;
  sort?: 'newest' | 'oldest' | 'relevance';
}

export interface CapturePage {
  rows: CaptureMetadataRow[];
  total: number;
}

export function listCaptures(db: Database, opts: CaptureQueryOptions = {}): CaptureMetadataRow[] {
  return queryCaptures(db, null, opts);
}

export function searchCaptures(
  db: Database,
  query: string,
  opts: CaptureQueryOptions = {},
): CaptureMetadataRow[] {
  return queryCaptures(db, query, opts);
}

export function countCaptures(db: Database, query: string | null, opts: CaptureQueryOptions = {}): number {
  return queryCapturePage(db, query, { ...opts, limit: 0, offset: 0 }, true).total;
}

function queryCaptures(db: Database, query: string | null, opts: CaptureQueryOptions): CaptureMetadataRow[] {
  return queryCapturePage(db, query, opts, false).rows;
}

function queryCapturePage(db: Database, query: string | null, opts: CaptureQueryOptions, countOnly: boolean): CapturePage {
  const where: string[] = [];
  const params: Array<string | number> = [];
  const joins = [query ? 'JOIN captures_fts f ON f.rowid = c.id' : ''];

  if (query) { where.push('captures_fts MATCH ?'); params.push(query); }
  if (opts.status && opts.status !== 'all') { where.push('c.status = ?'); params.push(opts.status); }
  if (!opts.status) where.push("c.status = 'succeeded'");
  if (opts.mode) { where.push('c.mode = ?'); params.push(opts.mode); }
  if (opts.domain) { where.push('u.domain = ?'); params.push(opts.domain); }
  if (opts.title) { where.push("c.title LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(opts.title)}%`); }
  if (opts.url) { where.push("(c.source_url LIKE ? ESCAPE '\\' OR c.final_url LIKE ? ESCAPE '\\')"); const p = `%${escapeLike(opts.url)}%`; params.push(p, p); }
  if (opts.dateFrom) { where.push('datetime(c.captured_at) >= datetime(?)'); params.push(opts.dateFrom); }
  if (opts.dateTo) { where.push('datetime(c.captured_at) < datetime(?, \'+1 day\')'); params.push(opts.dateTo); }
  if (opts.tag) {
    joins.push('JOIN capture_tags ct ON ct.capture_id = c.id JOIN tags t ON t.id = ct.tag_id');
    where.push('t.name = ?'); params.push(opts.tag);
  }

  const from = `FROM captures c JOIN urls u ON u.id = c.url_id ${CAPTURE_PDF_METADATA_JOINS} ${joins.filter(Boolean).join(' ')}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  if (countOnly) {
    const total = db.query<{ n: number }, any[]>(`SELECT COUNT(DISTINCT c.id) n ${from} ${whereSql}`).get(...params)?.n ?? 0;
    return { rows: [], total };
  }

  const sort = query && (opts.sort ?? 'relevance') === 'relevance'
    ? 'bm25(captures_fts) ASC, c.captured_at DESC, c.id DESC'
    : opts.sort === 'oldest' ? 'c.captured_at ASC, c.id ASC' : 'c.captured_at DESC, c.id DESC';
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  const rows = db.query<CaptureMetadataRow, any[]>(`
    SELECT ${CAPTURE_METADATA_COLUMNS}, u.domain ${from} ${whereSql}
    ORDER BY ${sort}
    LIMIT ? OFFSET ?
  `).all(...params);
  return { rows, total: 0 };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function findRecentCapture(db: Database, normalisedUrl: string, freshnessSeconds: number): CaptureMetadataRow | null {
  if (freshnessSeconds <= 0) return null;
  return db.query<CaptureMetadataRow, [string, number]>(`
    SELECT ${CAPTURE_METADATA_COLUMNS} FROM urls u JOIN captures c ON c.id = u.latest_capture ${CAPTURE_PDF_METADATA_JOINS}
    WHERE u.normalised = ? AND c.status = 'succeeded'
      AND c.captured_at >= datetime('now', '-' || ? || ' seconds')
  `).get(normalisedUrl, freshnessSeconds) ?? null;
}

export function addCaptureAlias(db: Database, captureId: number, url: string, kind: string): void {
  db.exec('INSERT OR IGNORE INTO capture_aliases (capture_id, url, kind) VALUES (?, ?, ?)', [captureId, url, kind]);
}

export function getCaptureAliases(db: Database, captureId: number): Array<{ url: string; kind: string }> {
  return db.query<{ url: string; kind: string }, [number]>(
    'SELECT url, kind FROM capture_aliases WHERE capture_id = ? ORDER BY id',
  ).all(captureId);
}

export interface CaptureImageSource {
  order: number;
  originalUrl: string | null;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
}

export function setCaptureImageSources(db: Database, captureId: number, images: CaptureImageSource[]): void {
  db.exec(`INSERT INTO metadata (capture_id, key, value) VALUES (?, 'image_sources', ?)
           ON CONFLICT(capture_id, key) DO UPDATE SET value=excluded.value`, [captureId, JSON.stringify(images)]);
}

export function getCaptureImageSources(db: Database, captureId: number): CaptureImageSource[] {
  const row = db.query<{ value: string | null }, [number]>(
    `SELECT value FROM metadata WHERE capture_id = ? AND key = 'image_sources'`,
  ).get(captureId);
  if (!row?.value) return [];
  try { const parsed = JSON.parse(row.value); return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}

export interface DeleteCaptureResult {
  id: number;
  sourceUrl: string;
  latestCaptureChanged: boolean;
  newLatestCapture: number | null;
  orphanUrlRemoved: boolean;
}

export function getCaptureDeleteImpact(db: Database, id: number) {
  const capture = getCaptureById(db, id);
  if (!capture) return null;
  return {
    id: capture.id,
    title: capture.title,
    sourceUrl: capture.source_url,
    capturedAt: capture.captured_at,
    aliases: db.query<{ n: number }, [number]>('SELECT COUNT(*) n FROM capture_aliases WHERE capture_id=?').get(id)?.n ?? 0,
    metadata: db.query<{ n: number }, [number]>('SELECT COUNT(*) n FROM metadata WHERE capture_id=?').get(id)?.n ?? 0,
    tags: db.query<{ n: number }, [number]>('SELECT COUNT(*) n FROM capture_tags WHERE capture_id=?').get(id)?.n ?? 0,
    jobs: db.query<{ n: number }, [number]>('SELECT COUNT(*) n FROM jobs WHERE capture_id=?').get(id)?.n ?? 0,
  };
}

export function deleteCapture(db: Database, id: number): DeleteCaptureResult | null {
  const capture = getCaptureById(db, id);
  if (!capture) return null;
  return db.transaction(() => {
    const url = db.query<{ latest_capture: number | null; normalised: string }, [number]>('SELECT latest_capture, normalised FROM urls WHERE id=?').get(capture.url_id);
    const latestCaptureChanged = url?.latest_capture === id;
    db.exec('UPDATE jobs SET capture_id=NULL, result=json_set(CASE WHEN json_valid(result) THEN result ELSE \'{}\' END, \'$.captureDeleted\', 1, \'$.deletedCaptureId\', ?) WHERE capture_id=?', [id, id]);
    db.exec('UPDATE archivebox_imports SET capture_id=NULL, outcome_detail=COALESCE(outcome_detail || \'; \', \'\') || ? WHERE capture_id=?', [`capture ${id} deleted`, id]);
    if (latestCaptureChanged) db.exec('UPDATE urls SET latest_capture=NULL WHERE id=?', [capture.url_id]);
    db.exec('DELETE FROM captures WHERE id=?', [id]);
    db.exec('DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM capture_tags WHERE tag_id=tags.id)');
    const replacement = db.query<{ id: number }, [number]>(`
      SELECT id FROM captures WHERE url_id=? AND status='succeeded'
      ORDER BY captured_at DESC, id DESC LIMIT 1
    `).get(capture.url_id)?.id ?? null;
    if (latestCaptureChanged) {
      db.exec(`UPDATE urls SET latest_capture=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [replacement, capture.url_id]);
    }
    const captureReferences = db.query<{ n: number }, [number]>(
      'SELECT COUNT(*) n FROM captures WHERE url_id=?',
    ).get(capture.url_id)?.n ?? 0;
    const jobReference = url ? jobReferencesNormalisedUrl(db, url.normalised) : false;
    const orphanUrlRemoved = captureReferences === 0 && !jobReference;
    if (orphanUrlRemoved) db.exec('DELETE FROM urls WHERE id=?', [capture.url_id]);
    return { id, sourceUrl: capture.source_url, latestCaptureChanged, newLatestCapture: replacement, orphanUrlRemoved };
  })();
}

function jobReferencesNormalisedUrl(db: Database, normalisedUrl: string): boolean {
  const rows = db.query<{ url: string }, []>(`
    SELECT json_extract(payload, '$.url') url FROM jobs
    WHERE json_valid(payload) AND json_type(payload, '$.url') = 'text'
  `).all();
  return rows.some((row) => {
    try { return normaliseUrl(row.url) === normalisedUrl; }
    catch { return false; }
  });
}

export function updateCaptureNote(db: Database, captureId: number, note: string | null): void {
  db.exec(`UPDATE captures SET note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`, [note, captureId]);
}

export interface AttachSourcePdfInput {
  captureId: number;
  bytes: Uint8Array;
  sourceKind: PdfSourceKind;
  sourceMime?: string | null;
  sourceFilename?: string | null;
  sourceLocator?: string | null;
}

/** Store byte-exact validated PDF bytes once and attach them to one capture. */
export function attachSourcePdf(db: Database, input: AttachSourcePdfInput): SourcePdfMetadata {
  const bytes = Buffer.isBuffer(input.bytes)
    ? input.bytes
    : Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength);
  if (bytes.byteLength < 5 || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new Error('Source document does not start with %PDF-');
  }
  const capture = db.query<{ id: number }, [number]>('SELECT id FROM captures WHERE id=?').get(input.captureId);
  if (!capture) throw new Error(`Capture ${input.captureId} not found`);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  db.transaction(() => {
    const previousBlobId = db.query<{ pdf_blob_id: number }, [number]>(
      'SELECT pdf_blob_id FROM capture_pdfs WHERE capture_id=?',
    ).get(input.captureId)?.pdf_blob_id ?? null;
    db.query(`INSERT OR IGNORE INTO pdf_blobs (sha256, byte_size, bytes) VALUES (?, ?, ?)`)
      .run(sha256, bytes.byteLength, bytes);
    const blob = db.query<{ id: number; byte_size: number }, [string]>(
      'SELECT id,byte_size FROM pdf_blobs WHERE sha256=?',
    ).get(sha256)!;
    if (blob.byte_size !== bytes.byteLength) throw new Error(`PDF hash collision for ${sha256}`);
    db.query(`INSERT INTO capture_pdfs
      (capture_id,pdf_blob_id,source_kind,source_mime,source_filename,source_locator)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(capture_id) DO UPDATE SET
        pdf_blob_id=excluded.pdf_blob_id, source_kind=excluded.source_kind,
        source_mime=excluded.source_mime, source_filename=excluded.source_filename,
        source_locator=excluded.source_locator, attached_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`)
      .run(input.captureId, blob.id, input.sourceKind, input.sourceMime ?? null, input.sourceFilename ?? null, input.sourceLocator ?? null);
    db.query(`INSERT OR IGNORE INTO pdf_extractions (pdf_blob_id,status) VALUES (?,'pending')`).run(blob.id);
    if (previousBlobId != null && previousBlobId !== blob.id) {
      db.query(`DELETE FROM pdf_blobs
        WHERE id=? AND NOT EXISTS (SELECT 1 FROM capture_pdfs WHERE pdf_blob_id=?)
          AND NOT EXISTS (SELECT 1 FROM archivebox_pdf_enrichment WHERE pdf_blob_id=?)`)
        .run(previousBlobId, previousBlobId, previousBlobId);
    }
  })();
  return getSourcePdfMetadata(db, input.captureId)!;
}

export function getSourcePdfMetadata(db: Database, captureId: number): SourcePdfMetadata | null {
  return db.query<SourcePdfMetadata, [number]>(`
    SELECT cp.capture_id, pb.id pdf_blob_id, pb.sha256, pb.byte_size,
      cp.source_kind,cp.source_mime,cp.source_filename,cp.source_locator,
      pe.status extraction_status,pe.page_count,pe.extracted_text_bytes,
      pe.text_truncated,pe.warnings extraction_warnings,pe.error extraction_error
    FROM capture_pdfs cp JOIN pdf_blobs pb ON pb.id=cp.pdf_blob_id
    JOIN pdf_extractions pe ON pe.pdf_blob_id=pb.id
    WHERE cp.capture_id=?
  `).get(captureId) ?? null;
}

export function getSourcePdfBytes(db: Database, captureId: number): Uint8Array | null {
  return db.query<{ bytes: Uint8Array }, [number]>(`
    SELECT pb.bytes FROM capture_pdfs cp JOIN pdf_blobs pb ON pb.id=cp.pdf_blob_id
    WHERE cp.capture_id=?
  `).get(captureId)?.bytes ?? null;
}

/** Read one inclusive byte range without materialising the whole PDF BLOB. */
export function beginPdfExtraction(db: Database, captureId: number, extractor: string): void {
  const pdf = getSourcePdfMetadata(db, captureId);
  if (!pdf) throw new Error(`Capture ${captureId} has no source PDF`);
  db.query(`UPDATE pdf_extractions SET status='running',extractor=?,error=NULL,
    started_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),completed_at=NULL,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE pdf_blob_id=?`)
    .run(extractor, pdf.pdf_blob_id);
}

export interface PdfExtractionUpdate {
  status: 'succeeded' | 'failed' | 'timeout' | 'encrypted' | 'image_only';
  pageCount: number | null;
  text: string;
  textBytes: number;
  textTruncated: boolean;
  warnings: string[];
  error: string | null;
  extractor: string;
}

export function savePdfExtraction(db: Database, captureId: number, result: PdfExtractionUpdate): void {
  const pdf = getSourcePdfMetadata(db, captureId);
  if (!pdf) throw new Error(`Capture ${captureId} has no source PDF`);
  db.transaction(() => {
    db.query(`UPDATE pdf_extractions SET
      status=?, page_count=?, extracted_text=?, extracted_text_bytes=?,
      text_truncated=?, warnings=?, error=?, extractor=?,
      completed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
      WHERE pdf_blob_id=?`)
      .run(result.status, result.pageCount, result.text || null, result.textBytes,
        result.textTruncated ? 1 : 0, result.warnings.length ? JSON.stringify(result.warnings) : null,
        result.error, result.extractor, pdf.pdf_blob_id);
    if (result.text) {
      db.query(`UPDATE captures SET extracted_text=?,
        title=COALESCE(NULLIF(title,''),?), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
        WHERE id=?`).run(result.text, pdf.source_filename, captureId);
    }
    if (result.warnings.length) appendCaptureWarnings(db, captureId, result.warnings);
  })();
}

export function appendCaptureWarnings(db: Database, captureId: number, warnings: string[]): void {
  if (!warnings.length) return;
  const current = db.query<{ warnings: string | null }, [number]>('SELECT warnings FROM captures WHERE id=?').get(captureId)?.warnings;
  let values: string[] = [];
  try { const parsed = current ? JSON.parse(current) : []; values = Array.isArray(parsed) ? parsed.map(String) : [String(current)]; }
  catch { if (current) values = [current]; }
  for (const warning of warnings) if (!values.includes(warning)) values.push(warning);
  db.query(`UPDATE captures SET warnings=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
    .run(JSON.stringify(values), captureId);
}

export function getSourcePdfText(db: Database, captureId: number): { text: string; status: string } | null {
  return db.query<{ text: string; status: string }, [number]>(`
    SELECT COALESCE(pe.extracted_text,'') text,pe.status FROM capture_pdfs cp
    JOIN pdf_extractions pe ON pe.pdf_blob_id=cp.pdf_blob_id WHERE cp.capture_id=?
  `).get(captureId) ?? null;
}

export function getSourcePdfRange(db: Database, captureId: number, start: number, end: number): Uint8Array | null {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error('Invalid PDF byte range');
  }
  const length = end - start + 1;
  return db.query<{ bytes: Uint8Array }, [number, number, number]>(`
    SELECT substr(pb.bytes, ?, ?) bytes
    FROM capture_pdfs cp JOIN pdf_blobs pb ON pb.id=cp.pdf_blob_id
    WHERE cp.capture_id=?
  `).get(start + 1, length, captureId)?.bytes ?? null;
}

export function getCaptureHtml(
  db: Database,
  id: number,
): CaptureBodyRow | null {
  return db
    .query<CaptureBodyRow, [number]>(
      'SELECT html, compression FROM captures WHERE id = ?',
    )
    .get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Job management
// ---------------------------------------------------------------------------

export function createJob(
  db: Database,
  kind: string,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
): number {
  const storedPayload = { ...payload, ...(idempotencyKey ? { idempotencyKey } : {}) };
  if (idempotencyKey) {
    const existing = db.query<{ id: number }, [string, string]>(`
      SELECT id FROM jobs
      WHERE kind = ? AND status IN ('queued','running','succeeded')
        AND json_extract(payload, '$.idempotencyKey') = ?
      ORDER BY id DESC LIMIT 1
    `).get(kind, idempotencyKey);
    if (existing) return existing.id;
  }
  const result = db
    .query<{ id: number }, any[]>(
      `INSERT INTO jobs (kind, status, payload) VALUES (?, 'queued', ?) RETURNING id`,
    )
    .get(kind, JSON.stringify(storedPayload));
  if (!result) throw new Error('INSERT jobs returned no id');
  return result.id;
}

export function claimNextJob(
  db: Database,
  kinds: string[],
): JobRow | null {
  if (kinds.length === 0) return null;
  // Atomic claim: update status to 'running', return the row
  const placeholders = kinds.map(() => '?').join(', ');
  const row = db
    .query<JobRow, any[]>(
      `UPDATE jobs SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         attempt_count = attempt_count + 1,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued' AND attempt_count < max_attempts AND kind IN (${placeholders})
         ORDER BY queued_at ASC
         LIMIT 1
       )
       RETURNING *`,
    )
    .get(...kinds);
  if (row) {
    db.exec(
      `INSERT INTO attempts (job_id, attempt) VALUES (?, ?)`,
      [row.id, row.attempt_count],
    );
  }
  return row ?? null;
}

export function finishJob(
  db: Database,
  id: number,
  status: 'succeeded' | 'failed',
  result?: Record<string, unknown>,
  error?: string,
): void {
  db.transaction(() => {
    db.exec(
      `UPDATE jobs SET status = ?, result = ?, error = ?,
         finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
      [status, result ? JSON.stringify(result) : null, error ?? null, id],
    );
    db.exec(
      `UPDATE attempts SET ended_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'), outcome = ?, error = ?
       WHERE id = (SELECT id FROM attempts WHERE job_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1)`,
      [status, error ?? null, id],
    );
  })();
}

export function recoverPendingCaptures(db: Database): number {
  const count = db.query<{ n: number }, []>("SELECT COUNT(*) n FROM captures WHERE status='pending'").get()?.n ?? 0;
  if (count) {
    db.exec(`UPDATE captures SET status='failed',error='Capture interrupted by process restart',
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE status='pending'`);
  }
  return count;
}

export function recoverStuckJobs(db: Database): number {
  // Retry abandoned jobs while attempts remain; otherwise terminate them.
  db.exec(
    `UPDATE jobs SET status = 'failed', error = 'Maximum attempts exhausted during recovery',
       finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE status = 'running' AND attempt_count >= max_attempts`,
  );
  const before = db.query<{ n: number }, []>(
    `SELECT COUNT(*) AS n FROM jobs WHERE status = 'running' AND attempt_count < max_attempts`,
  ).get()?.n ?? 0;
  db.exec(
    `UPDATE jobs SET status = 'queued', started_at = NULL,
       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE status = 'running' AND attempt_count < max_attempts`,
  );
  return before;
}

export function getJobAttempts(db: Database, id: number): Array<Record<string, unknown>> {
  return db.query<Record<string, unknown>, [number]>(
    'SELECT attempt, started_at, ended_at, outcome, error FROM attempts WHERE job_id = ? ORDER BY attempt',
  ).all(id);
}

export function getJobById(db: Database, id: number): JobRow | null {
  return db
    .query<JobRow, [number]>('SELECT * FROM jobs WHERE id = ?')
    .get(id) ?? null;
}

// ---------------------------------------------------------------------------
// Tag management
// ---------------------------------------------------------------------------

function normaliseTagName(name: string): string {
  const normalisedName = name.trim().replace(/\s+/g, ' ');
  if (!normalisedName || normalisedName.length > 100) {
    throw new Error('Tag names must contain 1 to 100 characters');
  }
  return normalisedName;
}

export function getOrCreateTag(db: Database, name: string): number {
  const normalisedName = normaliseTagName(name);
  const existing = db
    .query<{ id: number }, [string]>('SELECT id FROM tags WHERE name = ?')
    .get(normalisedName);
  if (existing) return existing.id;
  const created = db
    .query<{ id: number }, [string]>('INSERT INTO tags (name) VALUES (?) RETURNING id')
    .get(normalisedName);
  if (!created) throw new Error('INSERT tags failed');
  return created.id;
}

export function cancelJob(db: Database, id: number): boolean {
  const before = db.query<{ status: string }, [number]>('SELECT status FROM jobs WHERE id = ?').get(id);
  if (!before || before.status !== 'queued') return false;
  db.exec(`UPDATE jobs SET status='cancelled', finished_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`, [id]);
  return true;
}

export function addTagToCapture(db: Database, captureId: number, tagName: string): void {
  const tagId = getOrCreateTag(db, tagName);
  db.exec(
    'INSERT OR IGNORE INTO capture_tags (capture_id, tag_id) VALUES (?, ?)',
    [captureId, tagId],
  );
}

export function removeTagFromCapture(db: Database, captureId: number, tagName: string): boolean {
  const normalisedName = normaliseTagName(tagName);
  return db.transaction(() => {
    const tag = db.query<{ id: number }, [string]>('SELECT id FROM tags WHERE name = ?').get(normalisedName);
    if (!tag) return false;
    const removed = db.query<{ tag_id: number }, [number, number]>(
      'DELETE FROM capture_tags WHERE capture_id = ? AND tag_id = ? RETURNING tag_id',
    ).get(captureId, tag.id);
    if (!removed) return false;
    db.query('DELETE FROM tags WHERE id = ? AND NOT EXISTS (SELECT 1 FROM capture_tags WHERE tag_id = ?)')
      .run(tag.id, tag.id);
    return true;
  })();
}

export function getCaptureTags(db: Database, captureId: number): string[] {
  return db
    .query<{ name: string }, [number]>(
      'SELECT t.name FROM tags t JOIN capture_tags ct ON ct.tag_id = t.id WHERE ct.capture_id = ? ORDER BY t.name COLLATE NOCASE',
    )
    .all(captureId)
    .map((r) => r.name);
}

export function listTags(db: Database): Array<{ name: string; count: number }> {
  return db
    .query<{ name: string; count: number }, []>(
      `SELECT t.name, COUNT(ct.capture_id) as count
       FROM tags t
       JOIN capture_tags ct ON ct.tag_id = t.id
       GROUP BY t.id
       ORDER BY count DESC, t.name ASC`,
    )
    .all();
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
