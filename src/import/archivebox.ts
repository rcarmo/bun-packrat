import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normaliseUrl } from '../capture/url.js';
import { extractContent } from '../capture/extract.js';
import { normaliseImportedHtml } from '../capture/canonical.js';
import { addCaptureAlias, addTagToCapture, getOrCreateUrl, insertCapture, updateLatestCapture } from '../db/index.js';
import type { Compression } from '../types.js';

const ADAPTER = 'archivebox-django-core-v1';
const TOOL = 'packrat/archivebox-import-0.1.0';
const REQUIRED_SCHEMA: Record<string, string[]> = {
  core_snapshot: ['id', 'url', 'timestamp', 'title', 'bookmarked_at', 'downloaded_at'],
  core_archiveresult: ['snapshot_id', 'extractor', 'status', 'output'],
  core_tag: ['id', 'name'],
  core_snapshot_tags: ['snapshot_id', 'tag_id'],
};
const CANDIDATES = ['singlefile.html', 'output.html'] as const;
const DEFAULT_MAX_IMPORT_BYTES = 20 * 1024 * 1024;

type SourceSnapshot = {
  id: string;
  url: string;
  timestamp: string;
  title: string | null;
  bookmarked_at: string;
  downloaded_at: string | null;
};

type PreparedItem = {
  source: SourceSnapshot;
  paths: Record<string, { path: string; bytes: number }>;
  sourceStatus: string;
  sourceHash: string | null;
  tags: string[];
  body: Buffer | null;
  compression: Compression;
  contentHash: string | null;
  htmlSize: number | null;
  mode: 'imported_singlefile' | 'full_page' | 'metadata_only';
  metadata: ReturnType<typeof extractContent> | null;
  warnings: string[];
};

export interface ArchiveBoxImportOptions {
  dataRoot: string;
  sourceDatabase?: string;
  dryRun?: boolean;
  verifyOnly?: boolean;
  retryFailed?: boolean;
  limit?: number;
  compression?: 'none' | 'gzip';
  maxCandidateBytes?: number;
  reportJson?: string;
  reportHtml?: string;
}

export interface ArchiveBoxImportReport {
  ok: boolean;
  adapter: string;
  dryRun: boolean;
  verifyOnly: boolean;
  source: {
    dataRoot: string;
    database: string;
    schemaFingerprint: string;
    snapshots: number;
    snapshotDirectories: number;
    orphanDirectories: number;
    extractorResults: Array<{ extractor: string; status: string; count: number }>;
    candidateFiles: Record<string, { count: number; bytes: number }>;
    snapshotsWithoutDirectory: number;
    sourceBytesInspected: number;
  };
  plan: string[];
  outcomes: Record<string, number>;
  processed: number;
  resumed: number;
  failures: Array<{ abId: string; timestamp: string; error: string }>;
  reconciliation: { terminal: number; pending: number; total: number };
  targetDatabaseBytes: number | null;
  elapsedMs: number;
}

export async function importArchiveBox(target: Database, options: ArchiveBoxImportOptions): Promise<ArchiveBoxImportReport> {
  const started = performance.now();
  const dataRoot = resolve(options.dataRoot);
  const sourceDatabase = resolve(options.sourceDatabase ?? join(dataRoot, 'index.sqlite3'));
  if (!existsSync(sourceDatabase)) throw new Error(`ArchiveBox database not found: ${sourceDatabase}`);
  const archiveRoot = join(dataRoot, 'archive');
  if (!existsSync(archiveRoot)) throw new Error(`ArchiveBox archive directory not found: ${archiveRoot}`);

  const source = new Database(sourceDatabase, { readonly: true, strict: true });
  try {
    const schema = validateSchema(source);
    const schemaFingerprint = createHash('sha256').update(JSON.stringify(schema)).digest('hex');
    const snapshots = source.query<SourceSnapshot, []>(`
      SELECT id, url, timestamp, title, bookmarked_at, downloaded_at
      FROM core_snapshot ORDER BY timestamp, id
    `).all();
    const sourceIds = new Set(snapshots.map((row) => row.timestamp));
    const directories = readdirSync(archiveRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    const candidateFiles: Record<string, { count: number; bytes: number }> = Object.fromEntries(CANDIDATES.map((name) => [name, { count: 0, bytes: 0 }]));
    let snapshotsWithoutDirectory = 0;
    for (const row of snapshots) {
      const directory = join(archiveRoot, row.timestamp);
      if (!existsSync(directory)) snapshotsWithoutDirectory++;
      for (const name of CANDIDATES) {
        const path = join(directory, name);
        if (!existsSync(path) || !statSync(path).isFile()) continue;
        candidateFiles[name].count++;
        candidateFiles[name].bytes += statSync(path).size;
      }
    }
    const extractorResults = source.query<{ extractor: string; status: string; count: number }, []>(`
      SELECT extractor, status, count(*) AS count FROM core_archiveresult
      GROUP BY extractor, status ORDER BY extractor, status
    `).all();
    const inventory = {
      dataRoot,
      database: sourceDatabase,
      schemaFingerprint,
      snapshots: snapshots.length,
      snapshotDirectories: directories.length,
      orphanDirectories: directories.filter((name) => !sourceIds.has(name)).length,
      extractorResults,
      candidateFiles,
      snapshotsWithoutDirectory,
      sourceBytesInspected: Object.values(candidateFiles).reduce((sum, item) => sum + item.bytes, 0),
    };
    const plan = [
      'Read ArchiveBox source files without network access or source writes.',
      'Prefer singlefile.html; otherwise normalise output.html; otherwise create a metadata-only capture.',
      'Remove active content and unresolved remote or local resource dependencies.',
      'Store one durable archivebox_imports outcome per source snapshot and resume terminal outcomes.',
      'Reuse an existing capture for exact normalised-body hashes and record the duplicate decision.',
    ];

    if (options.dryRun) return finishReport(baseReport(inventory, plan, true, false), target, options, started);
    if (options.verifyOnly) {
      const report = baseReport(inventory, plan, false, true);
      verifyImportedRows(target, snapshots, report);
      return finishReport(report, target, options, started);
    }

    // Reject a different ArchiveBox source that reuses an existing snapshot
    // ID before writing any new provenance rows.
    assertExistingSourceRowsCompatible(target, snapshots);

    // Discovery is durable before conversion starts. Existing rows preserve
    // terminal outcomes and make an interrupted run resumable.
    target.transaction(() => {
      const insert = target.query(`
        INSERT OR IGNORE INTO archivebox_imports
          (ab_id, ab_url, ab_timestamp, ab_status, ab_paths, outcome)
        VALUES (?, ?, ?, ?, '[]', NULL)
      `);
      for (const row of snapshots) insert.run(row.id, row.url, row.timestamp, row.downloaded_at ? 'downloaded' : 'pending');
    })();
    assertSourceRowsMatch(target, snapshots);

    const report = baseReport(inventory, plan, false, false);
    const selected = options.limit && options.limit > 0 ? snapshots.slice(0, options.limit) : snapshots;
    for (const row of selected) {
      const existing = target.query<{ outcome: string | null }, [string]>('SELECT outcome FROM archivebox_imports WHERE ab_id=?').get(row.id);
      if (existing?.outcome && !(options.retryFailed && existing.outcome === 'failed')) {
        report.resumed++;
        report.outcomes[existing.outcome] = (report.outcomes[existing.outcome] ?? 0) + 1;
        continue;
      }
      try {
        const item = prepareItem(source, row, archiveRoot, options.compression ?? 'none', options.maxCandidateBytes ?? DEFAULT_MAX_IMPORT_BYTES);
        storeItem(target, item);
        report.processed++;
        const outcome = target.query<{ outcome: string }, [string]>('SELECT outcome FROM archivebox_imports WHERE ab_id=?').get(row.id)?.outcome ?? 'failed';
        report.outcomes[outcome] = (report.outcomes[outcome] ?? 0) + 1;
      } catch (error: any) {
        const message = String(error?.message ?? error).slice(0, 1000);
        target.exec(`UPDATE archivebox_imports SET outcome='failed', outcome_detail=?, processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ab_id=?`, [message, row.id]);
        report.processed++;
        report.outcomes.failed = (report.outcomes.failed ?? 0) + 1;
        if (report.failures.length < 100) report.failures.push({ abId: row.id, timestamp: row.timestamp, error: message });
      }
    }
    reconcile(target, report);
    report.ok = report.reconciliation.pending === (snapshots.length - selected.length) && (report.outcomes.failed ?? 0) === 0;
    return finishReport(report, target, options, started);
  } finally {
    source.close();
  }
}

function prepareItem(sourceDb: Database, source: SourceSnapshot, archiveRoot: string, compression: 'none' | 'gzip', maxCandidateBytes: number): PreparedItem {
  const directory = join(archiveRoot, source.timestamp);
  const paths: Record<string, { path: string; bytes: number }> = {};
  for (const name of CANDIDATES) {
    const path = join(directory, name);
    if (existsSync(path) && statSync(path).isFile()) paths[name] = { path, bytes: statSync(path).size };
  }
  const tags = sourceDb.query<{ name: string }, [string]>(`
    SELECT t.name FROM core_tag t JOIN core_snapshot_tags st ON st.tag_id=t.id
    WHERE st.snapshot_id=? ORDER BY t.name
  `).all(source.id).map((row) => row.name);
  const statuses = sourceDb.query<{ extractor: string; status: string }, [string]>('SELECT extractor,status FROM core_archiveresult WHERE snapshot_id=? ORDER BY extractor',).all(source.id);
  const sourceStatus = JSON.stringify(statuses);
  const warnings: string[] = [];

  let firstSourceHash: string | null = null;
  for (const candidate of CANDIDATES) {
    if (!paths[candidate]) continue;
    if (paths[candidate].bytes > maxCandidateBytes) {
      warnings.push(`${candidate} exceeds the ${maxCandidateBytes} byte import limit; trying the next candidate`);
      continue;
    }
    const raw = readFileSync(paths[candidate].path);
    const sourceHash = createHash('sha256').update(raw).digest('hex');
    firstSourceHash ??= sourceHash;
    try {
      const normalised = normaliseImportedHtml(raw.toString('utf8'), source.url);
      warnings.push(...normalised.warnings);
      const canonical = Buffer.from(normalised.html, 'utf8');
      const contentHash = createHash('sha256').update(canonical).digest('hex');
      const metadata = extractContent(normalised.html, source.url);
      warnings.push(...metadata.extractionWarnings);
      const body = compression === 'gzip' ? gzipSync(canonical) : canonical;
      return {
        source, paths, sourceStatus, sourceHash, tags, body,
        compression, contentHash, htmlSize: canonical.length,
        mode: candidate === 'singlefile.html' ? 'imported_singlefile' : 'full_page',
        metadata, warnings,
      };
    } catch (error: any) {
      warnings.push(`${candidate} rejected: ${String(error?.message ?? error).slice(0, 300)}`);
    }
  }

  warnings.push(Object.keys(paths).length ? 'No HTML candidate passed bounded validation; imported metadata only' : 'ArchiveBox snapshot has no usable HTML body');
  return { source, paths, sourceStatus, sourceHash: firstSourceHash, tags, body: null, compression: 'none', contentHash: null, htmlSize: null, mode: 'metadata_only', metadata: null, warnings };
}

function storeItem(db: Database, item: PreparedItem): void {
  db.transaction(() => {
    const duplicate = item.contentHash
      ? db.query<{ id: number }, [string]>('SELECT id FROM captures WHERE content_hash=? AND status=\'succeeded\' ORDER BY id LIMIT 1').get(item.contentHash)
      : null;
    if (duplicate) {
      addCaptureAlias(db, duplicate.id, item.source.url, 'original');
      for (const tag of item.tags) addTagToCapture(db, duplicate.id, tag);
      db.exec(`UPDATE archivebox_imports SET ab_status=?, ab_paths=?, ab_source_hash=?, capture_id=?, outcome='duplicate', outcome_detail=?, processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ab_id=?`, [item.sourceStatus, JSON.stringify(item.paths), item.sourceHash, duplicate.id, `Exact canonical content hash matches capture ${duplicate.id}; source URL retained as an alias and tags merged`, item.source.id]);
      return;
    }

    let normalised: string;
    try { normalised = normaliseUrl(item.source.url); }
    catch (error: any) {
      db.exec(`UPDATE archivebox_imports SET ab_status=?, ab_paths=?, ab_source_hash=?, outcome='skipped', outcome_detail=?, processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ab_id=?`, [item.sourceStatus, JSON.stringify(item.paths), item.sourceHash, `Unsupported source URL: ${error?.message ?? error}`, item.source.id]);
      return;
    }
    const url = getOrCreateUrl(db, normalised, item.source.url);
    const captureId = insertCapture(db, {
      url_id: url.id,
      source_url: item.source.url,
      final_url: item.source.url,
      html: item.body,
      compression: item.compression,
      content_hash: item.contentHash,
      html_size: item.htmlSize,
      title: item.metadata?.title ?? item.source.title,
      author: item.metadata?.author ?? null,
      site_name: item.metadata?.siteName ?? null,
      published_at: item.metadata?.publishedAt ?? null,
      excerpt: item.metadata?.excerpt ?? null,
      lang: item.metadata?.lang ?? null,
      extracted_text: item.metadata?.extractedText ?? item.source.title ?? item.source.url,
      mode: item.mode,
      status: 'succeeded',
      capture_tool: TOOL,
      warnings: item.warnings.length ? JSON.stringify(item.warnings) : null,
    });
    const capturedAt = archiveBoxDate(item.source.downloaded_at ?? item.source.bookmarked_at, item.source.timestamp);
    db.exec('UPDATE captures SET captured_at=?, created_at=?, updated_at=? WHERE id=?', [capturedAt, capturedAt, capturedAt, captureId]);
    updateLatestCaptureIfNewer(db, url.id, captureId, capturedAt);
    addCaptureAlias(db, captureId, item.source.url, 'original');
    for (const tag of item.tags) addTagToCapture(db, captureId, tag);
    db.exec(`UPDATE archivebox_imports SET ab_status=?, ab_paths=?, ab_source_hash=?, capture_id=?, outcome='imported', outcome_detail=?, processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE ab_id=?`, [item.sourceStatus, JSON.stringify(item.paths), item.sourceHash, captureId, item.mode, item.source.id]);
  })();
}

function updateLatestCaptureIfNewer(db: Database, urlId: number, captureId: number, capturedAt: string): void {
  const current = db.query<{ id: number; captured_at: string }, [number]>('SELECT c.id,c.captured_at FROM urls u LEFT JOIN captures c ON c.id=u.latest_capture WHERE u.id=?').get(urlId);
  if (!current?.id || current.captured_at <= capturedAt) updateLatestCapture(db, urlId, captureId);
}

function archiveBoxDate(value: string | null, timestamp: string): string {
  if (value) {
    const parsed = new Date(value.endsWith('Z') || /[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`);
    if (!Number.isNaN(parsed.valueOf())) return parsed.toISOString().replace('.000Z', 'Z');
  }
  const seconds = Number(timestamp);
  if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString();
  throw new Error(`ArchiveBox timestamp is not parseable: ${timestamp}`);
}

function validateSchema(db: Database): Record<string, string[]> {
  const actual: Record<string, string[]> = {};
  for (const [table, required] of Object.entries(REQUIRED_SCHEMA)) {
    const columns = db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((column) => column.name).sort();
    actual[table] = columns;
    const missing = required.filter((column) => !columns.includes(column));
    if (missing.length) throw new Error(`Unsupported ArchiveBox schema: ${table} is missing ${missing.join(', ')}`);
  }
  return actual;
}

function assertExistingSourceRowsCompatible(db: Database, snapshots: SourceSnapshot[]): void {
  const lookup = db.query<{ ab_url: string; ab_timestamp: string | null }, [string]>('SELECT ab_url,ab_timestamp FROM archivebox_imports WHERE ab_id=?');
  for (const source of snapshots) {
    const target = lookup.get(source.id);
    if (target && (target.ab_url !== source.url || target.ab_timestamp !== source.timestamp)) {
      throw new Error(`ArchiveBox source identity conflicts with existing provenance row: ${source.id}`);
    }
  }
}

function assertSourceRowsMatch(db: Database, snapshots: SourceSnapshot[]): void {
  const lookup = db.query<{ ab_url: string; ab_timestamp: string | null }, [string]>('SELECT ab_url,ab_timestamp FROM archivebox_imports WHERE ab_id=?');
  for (const source of snapshots) {
    const target = lookup.get(source.id);
    if (!target) throw new Error(`ArchiveBox provenance row is missing after discovery: ${source.id}`);
    if (target.ab_url !== source.url || target.ab_timestamp !== source.timestamp) {
      throw new Error(`ArchiveBox source identity conflicts with existing provenance row: ${source.id}`);
    }
  }
}

function verifyImportedRows(db: Database, snapshots: SourceSnapshot[], report: ArchiveBoxImportReport): void {
  const expected = new Map(snapshots.map((source) => [source.id, source]));
  const rows = db.query<{ ab_id: string; ab_url: string; ab_timestamp: string | null; outcome: string | null; capture_id: number | null; capture_exists: number }, []>(`
    SELECT ai.ab_id,ai.ab_url,ai.ab_timestamp,ai.outcome,ai.capture_id,
      CASE WHEN c.id IS NULL THEN 0 ELSE 1 END capture_exists
    FROM archivebox_imports ai LEFT JOIN captures c ON c.id=ai.capture_id
  `).all();
  const seen = new Set<string>();
  for (const row of rows) {
    const source = expected.get(row.ab_id);
    if (!source) continue;
    seen.add(row.ab_id);
    let error = '';
    if (row.ab_url !== source.url || row.ab_timestamp !== source.timestamp) error = 'source URL or timestamp does not match current ArchiveBox source';
    else if (!row.outcome) error = 'pending outcome';
    else if (['imported', 'duplicate'].includes(row.outcome) && row.capture_id == null) error = 'missing capture reference';
    else if (row.capture_id != null && !row.capture_exists) error = 'dangling capture reference';
    if (error && report.failures.length < 100) report.failures.push({ abId: row.ab_id, timestamp: source.timestamp, error });
  }
  for (const source of snapshots) {
    if (!seen.has(source.id) && report.failures.length < 100) report.failures.push({ abId: source.id, timestamp: source.timestamp, error: 'source snapshot has no provenance row' });
  }
  reconcile(db, report);
  const currentSourceTerminal = rows.filter((row) => expected.has(row.ab_id) && row.outcome).length;
  report.reconciliation = { terminal: currentSourceTerminal, pending: snapshots.length - currentSourceTerminal, total: snapshots.length };
  report.ok = report.failures.length === 0 && seen.size === snapshots.length && report.reconciliation.pending === 0;
}

function reconcile(db: Database, report: ArchiveBoxImportReport): void {
  const rows = db.query<{ outcome: string | null; count: number }, []>('SELECT outcome,count(*) count FROM archivebox_imports GROUP BY outcome').all();
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const pending = rows.filter((row) => !row.outcome).reduce((sum, row) => sum + row.count, 0);
  report.reconciliation = { terminal: total - pending, pending, total };
}

function baseReport(source: ArchiveBoxImportReport['source'], plan: string[], dryRun: boolean, verifyOnly: boolean): ArchiveBoxImportReport {
  return { ok: true, adapter: ADAPTER, dryRun, verifyOnly, source, plan, outcomes: {}, processed: 0, resumed: 0, failures: [], reconciliation: { terminal: 0, pending: source.snapshots, total: source.snapshots }, targetDatabaseBytes: null, elapsedMs: 0 };
}

function finishReport(report: ArchiveBoxImportReport, target: Database, options: ArchiveBoxImportOptions, started: number): ArchiveBoxImportReport {
  const database = target.query<{ file: string }, []>('PRAGMA database_list').all().find((row) => row.file)?.file;
  report.targetDatabaseBytes = database && existsSync(database) ? statSync(database).size : null;
  report.elapsedMs = Math.round(performance.now() - started);
  if (options.reportJson) writeFileSync(options.reportJson, JSON.stringify(report, null, 2));
  if (options.reportHtml) writeFileSync(options.reportHtml, renderReportHtml(report));
  return report;
}

function renderReportHtml(report: ArchiveBoxImportReport): string {
  const escape = (value: unknown) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const outcomes = Object.entries(report.outcomes).map(([name, count]) => `<tr><th>${escape(name)}</th><td>${count}</td></tr>`).join('');
  const failures = report.failures.map((item) => `<li><code>${escape(item.abId)}</code>: ${escape(item.error)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>ArchiveBox migration report</title><style>body{font:16px/1.5 system-ui;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse}th,td{padding:.4rem .8rem;border:1px solid #ccc;text-align:left}code{overflow-wrap:anywhere}</style></head><body><h1>ArchiveBox migration report</h1><p>Adapter: <code>${escape(report.adapter)}</code></p><p>Source snapshots: ${report.source.snapshots}; terminal outcomes: ${report.reconciliation.terminal}; pending: ${report.reconciliation.pending}.</p><table><tbody>${outcomes}</tbody></table><h2>Failures</h2><ul>${failures || '<li>None</li>'}</ul></body></html>`;
}
