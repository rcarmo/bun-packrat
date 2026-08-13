/**
 * bun-packrat — database layer
 * Opens (or creates) the SQLite database, runs pending migrations,
 * and exports typed query helpers.
 */

import { Database } from 'bun:sqlite';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { CaptureRow, UrlRow, JobRow } from '../types.js';
import { normaliseUrl } from '../capture/url.js';

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
      db.exec(sql);
    })();

    console.log(`[db] Applied migration ${version}: ${file}`);
  }
}

function ensureApplicationFeatureColumns(db: Database): void {
  const existing = new Set(
    db.query<{ name: string }, []>('PRAGMA table_info(captures)').all().map((column) => column.name),
  );
  const columns = [
    ['error', 'TEXT'],
    ['note', 'TEXT'],
    ['capture_duration_ms', 'INTEGER'],
  ] as const;
  for (const [name, type] of columns) {
    if (!existing.has(name)) db.exec(`ALTER TABLE captures ADD COLUMN ${name} ${type}`);
  }
}

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

export function insertCapture(
  db: Database,
  row: Omit<CaptureRow, 'id' | 'created_at' | 'updated_at' | 'captured_at' | 'error' | 'note' | 'capture_duration_ms'>,
): number {
  const result = db
    .query<{ id: number }, any[]>(`
      INSERT INTO captures (
        url_id, source_url, final_url, html, compression,
        content_hash, html_size, title, author, site_name,
        published_at, excerpt, lang, extracted_text,
        mode, status, capture_tool, warnings
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
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

export function getCaptureById(db: Database, id: number): CaptureRow | null {
  return db
    .query<CaptureRow, [number]>('SELECT * FROM captures WHERE id = ?')
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
  rows: CaptureRow[];
  total: number;
}

export function listCaptures(db: Database, opts: CaptureQueryOptions = {}): CaptureRow[] {
  return queryCaptures(db, null, opts);
}

export function searchCaptures(
  db: Database,
  query: string,
  opts: CaptureQueryOptions = {},
): CaptureRow[] {
  return queryCaptures(db, query, opts);
}

export function countCaptures(db: Database, query: string | null, opts: CaptureQueryOptions = {}): number {
  return queryCapturePage(db, query, { ...opts, limit: 0, offset: 0 }, true).total;
}

function queryCaptures(db: Database, query: string | null, opts: CaptureQueryOptions): CaptureRow[] {
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

  const from = `FROM captures c JOIN urls u ON u.id = c.url_id ${joins.filter(Boolean).join(' ')}`;
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  if (countOnly) {
    const total = db.query<{ n: number }, any[]>(`SELECT COUNT(DISTINCT c.id) n ${from} ${whereSql}`).get(...params)?.n ?? 0;
    return { rows: [], total };
  }

  const sort = query && (opts.sort ?? 'relevance') === 'relevance'
    ? 'bm25(captures_fts) ASC, c.captured_at DESC, c.id DESC'
    : opts.sort === 'oldest' ? 'c.captured_at ASC, c.id ASC' : 'c.captured_at DESC, c.id DESC';
  params.push(opts.limit ?? 50, opts.offset ?? 0);
  const rows = db.query<CaptureRow, any[]>(`
    SELECT c.*, u.domain ${from} ${whereSql}
    ORDER BY ${sort}
    LIMIT ? OFFSET ?
  `).all(...params);
  return { rows, total: 0 };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}

export function findRecentCapture(db: Database, normalisedUrl: string, freshnessSeconds: number): CaptureRow | null {
  if (freshnessSeconds <= 0) return null;
  return db.query<CaptureRow, [string, number]>(`
    SELECT c.* FROM urls u JOIN captures c ON c.id = u.latest_capture
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

export function getCaptureHtml(
  db: Database,
  id: number,
): { html: Uint8Array | null; compression: string } | null {
  return db
    .query<{ html: Uint8Array | null; compression: string }, [number]>(
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

export function getOrCreateTag(db: Database, name: string): number {
  const normalisedName = name.trim().replace(/\s+/g, ' ');
  if (!normalisedName || normalisedName.length > 100) {
    throw new Error('Tag names must contain 1 to 100 characters');
  }
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

export function getCaptureTags(db: Database, captureId: number): string[] {
  return db
    .query<{ name: string }, [number]>(
      'SELECT t.name FROM tags t JOIN capture_tags ct ON ct.tag_id = t.id WHERE ct.capture_id = ?',
    )
    .all(captureId)
    .map((r) => r.name);
}

export function listTags(db: Database): Array<{ name: string; count: number }> {
  return db
    .query<{ name: string; count: number }, []>(
      `SELECT t.name, COUNT(ct.capture_id) as count
       FROM tags t
       LEFT JOIN capture_tags ct ON ct.tag_id = t.id
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
