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
  ];

  for (const { version, file } of migrations) {
    if (applied.includes(version)) continue;

    const sqlPath = join(migrationsDir, file);
    if (!existsSync(sqlPath)) {
      throw new Error(`Migration file not found: ${sqlPath}`);
    }

    const sql = readFileSync(sqlPath, 'utf-8');

    // Run the migration — split on semicolons for multi-statement scripts
    // but use exec() which handles multiple statements
    db.exec(sql);

    console.log(`[db] Applied migration ${version}: ${file}`);
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
    'INSERT INTO urls (normalised, original, domain) VALUES (?, ?, ?)',
    [normalised, original, domain],
  );

  return db
    .query<UrlRow, [string]>('SELECT * FROM urls WHERE normalised = ?')
    .get(normalised)!;
}

export function insertCapture(
  db: Database,
  row: Omit<CaptureRow, 'id' | 'created_at' | 'updated_at' | 'captured_at'>,
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
    `UPDATE captures SET status = ?, warnings = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`,
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

export function listCaptures(
  db: Database,
  opts: { limit?: number; offset?: number; status?: string } = {},
): CaptureRow[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const status = opts.status ?? 'succeeded';

  return db
    .query<CaptureRow, [string, number, number]>(
      `SELECT c.*, u.domain
       FROM captures c
       JOIN urls u ON u.id = c.url_id
       WHERE c.status = ?
       ORDER BY c.captured_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(status, limit, offset);
}

export function searchCaptures(
  db: Database,
  query: string,
  opts: { limit?: number; offset?: number } = {},
): CaptureRow[] {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  return db
    .query<CaptureRow, [string, number, number]>(`
      SELECT c.*
      FROM captures_fts f
      JOIN captures c ON c.id = f.rowid
      WHERE captures_fts MATCH ?
        AND c.status = 'succeeded'
      ORDER BY rank
      LIMIT ? OFFSET ?
    `)
    .all(query, limit, offset);
}

export function getCaptureHtml(
  db: Database,
  id: number,
): { html: Buffer | null; compression: string } | null {
  return db
    .query<{ html: Buffer | null; compression: string }, [number]>(
      'SELECT html, compression FROM captures WHERE id = ?',
    )
    .get(id) ?? null;
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
