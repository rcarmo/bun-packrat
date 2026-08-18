#!/usr/bin/env bun
/**
 * bun-packrat CLI
 * Usage: bun run src/cli/index.ts <command> [args]
 *
 * Commands:
 *   capture <url>                   Capture a URL (blocking)
 *   import archivebox --data-root   Import or inventory ArchiveBox
 *   import archivebox-pdfs          Enrich verified original PDF responses
 *   import status                   Inspect ArchiveBox import outcomes
 *   search  <query>                 Full-text search
 *   list    [--limit N]             List recent captures
 *   export  <id> --format <fmt>     Export a capture (html|md|epub|pdf)
 *   backup  <dest.sqlite>           VACUUM INTO backup
 *   verify  [--all | --id N]        Content-hash + integrity check
 *   migrate                         Run pending migrations
 *   status                          Database statistics
 */

import { createHash } from 'crypto';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { openDatabase, runMigrations, searchCaptures, listCaptures, getCaptureById, getCaptureHtml, getCaptureDeleteImpact, deleteCapture } from '../db/index.js';
import { capturePage } from '../capture/pipeline.js';
import { exportHtml } from '../export/html.js';
import { exportMarkdownZip } from '../export/markdown.js';
import { exportEpub } from '../export/epub.js';
import { exportPdf } from '../export/pdf.js';
import { loadConfig } from '../config.js';
import { importArchiveBox } from '../import/archivebox.js';
import { enrichArchiveBoxPdfs } from '../import/archivebox-pdf.js';

const config = loadConfig();
const args = process.argv.slice(2);
const command = args[0];

if (!command || command === 'help' || command === '--help') {
  printHelp();
  process.exit(0);
}

const db = openDatabase(config.dbPath);
runMigrations(db);

switch (command) {
  // ── capture ──────────────────────────────────────────────────────────────
  case 'capture': {
    const url = args[1];
    if (!url) { console.error('Usage: packrat capture <url>'); process.exit(1); }
    console.error(`[capture] Archiving: ${url}`);
    try {
      const result = await capturePage(url, { config, db, force: args.includes('--force') });
      console.log(JSON.stringify({
        ok: true, captureId: result.captureId,
        url: `${config.baseUrl}/captures/${result.captureId}`,
        title: result.title, mode: result.mode, finalUrl: result.finalUrl,
        htmlSize: result.htmlSize, contentHash: result.contentHash,
        warnings: result.warnings,
      }, null, 2));
    } catch (err: any) {
      console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2));
      process.exit(1);
    }
    break;
  }

  // ── import ───────────────────────────────────────────────────────────────
  case 'import': {
    const subcommand = args[1];
    if (subcommand === 'archivebox-pdfs') {
      const dataRoot = optionValue(args, '--data-root');
      if (!dataRoot) { console.error('Usage: packrat import archivebox-pdfs --data-root <path> [--verify-only|--retry-failed]'); process.exit(1); }
      try {
        const report = await enrichArchiveBoxPdfs(db, {
          dataRoot,
          sourceDatabase: optionValue(args, '--database') ?? undefined,
          maxPdfBytes: config.maxPdfSizeBytes,
          extractionTimeoutMs: config.pdfExtractionTimeoutMs,
          maxPages: config.maxPdfPages,
          maxTextBytes: config.maxPdfTextBytes,
          limit: optionValue(args, '--limit') ? boundedInt(optionValue(args, '--limit'), 0, 1, Number.MAX_SAFE_INTEGER) : undefined,
          retryFailed: args.includes('--retry-failed'),
          verifyOnly: args.includes('--verify-only'),
        });
        console.log(JSON.stringify(report, null, 2));
        if (!report.ok) process.exitCode = 1;
      } catch (err: any) {
        console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2));
        process.exit(1);
      }
      break;
    }
    if (subcommand === 'status') {
      const outcomes = db.query<{ outcome: string | null; count: number }, []>('SELECT outcome,count(*) count FROM archivebox_imports GROUP BY outcome ORDER BY outcome').all();
      const recentFailures = db.query<any, []>("SELECT ab_id,ab_url,ab_timestamp,outcome_detail,processed_at FROM archivebox_imports WHERE outcome='failed' ORDER BY processed_at DESC LIMIT 20").all();
      console.log(JSON.stringify({ ok: true, outcomes, recentFailures }, null, 2));
      break;
    }
    if (subcommand !== 'archivebox') {
      console.error('Usage: packrat import archivebox|archivebox-pdfs --data-root <path> [--database <index.sqlite3>] [--dry-run|--verify-only]');
      process.exit(1);
    }
    const dataRoot = optionValue(args, '--data-root');
    if (!dataRoot) { console.error('Usage: packrat import archivebox --data-root <path>'); process.exit(1); }
    try {
      const report = await importArchiveBox(db, {
        dataRoot,
        sourceDatabase: optionValue(args, '--database') ?? undefined,
        dryRun: args.includes('--dry-run'),
        verifyOnly: args.includes('--verify-only'),
        retryFailed: args.includes('--retry-failed'),
        limit: optionValue(args, '--limit') ? boundedInt(optionValue(args, '--limit'), 0, 1, Number.MAX_SAFE_INTEGER) : undefined,
        compression: config.htmlCompression,
        maxCandidateBytes: optionValue(args, '--max-candidate-bytes') ? boundedInt(optionValue(args, '--max-candidate-bytes'), config.maxPageSizeBytes, 1, Number.MAX_SAFE_INTEGER) : config.maxPageSizeBytes,
        reportJson: optionValue(args, '--report-json') ?? undefined,
        reportHtml: optionValue(args, '--report-html') ?? undefined,
      });
      console.log(JSON.stringify(report, null, 2));
      if (!report.ok) process.exitCode = 1;
    } catch (err: any) {
      console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2));
      process.exit(1);
    }
    break;
  }

  // ── search ───────────────────────────────────────────────────────────────
  case 'search': {
    const filterNames = new Set(['--domain', '--tag', '--mode', '--status', '--sort', '--limit']);
    const queryParts: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (filterNames.has(args[i])) { i++; continue; }
      if (!args[i].startsWith('--')) queryParts.push(args[i]);
    }
    const query = queryParts.join(' ');
    if (!query) { console.error('Usage: packrat search <query>'); process.exit(1); }
    const sortArg = optionValue(args, '--sort');
    const sort = sortArg === 'oldest' || sortArg === 'newest' ? sortArg : 'relevance';
    console.log(JSON.stringify(searchCaptures(db, query, {
      limit: boundedInt(optionValue(args, '--limit'), 50, 1, 200), sort,
      status: optionValue(args, '--status') ?? undefined,
      mode: optionValue(args, '--mode') ?? undefined,
      domain: optionValue(args, '--domain') ?? undefined,
      tag: optionValue(args, '--tag') ?? undefined,
    }).map(summarise), null, 2));
    break;
  }

  // ── list ─────────────────────────────────────────────────────────────────
  case 'list': {
    const li = args.indexOf('--limit');
    const limit = li !== -1 ? parseInt(args[li + 1], 10) : 20;
    console.log(JSON.stringify(listCaptures(db, { limit }).map(summarise), null, 2));
    break;
  }

  // ── export ───────────────────────────────────────────────────────────────
  case 'export': {
    const id = parseInt(args[1], 10);
    const fmtIdx = args.indexOf('--format');
    const fmt = fmtIdx !== -1 ? args[fmtIdx + 1] : 'html';
    const outIdx = args.indexOf('--output');
    let outPath: string | undefined = outIdx !== -1 ? args[outIdx + 1] : undefined;

    if (!id || isNaN(id)) { console.error('Usage: packrat export <id> --format html|md|epub|pdf'); process.exit(1); }

    const meta = getCaptureById(db, id);
    if (!meta) { console.error(`Capture ${id} not found`); process.exit(1); }

    console.error(`[export] capture ${id} as ${fmt}`);

    try {
      let bytes: Uint8Array;
      let defaultExt: string;

      switch (fmt) {
        case 'html': {
          const r = await exportHtml(db, id);
          if (!r) { console.error('Export failed'); process.exit(1); }
          bytes = r.html; defaultExt = '.html';
          outPath ??= r.filename;
          break;
        }
        case 'md': {
          const r = await exportMarkdownZip(db, id);
          if (!r) { console.error('Export failed'); process.exit(1); }
          bytes = r.zip; defaultExt = '.zip';
          outPath ??= r.filename;
          break;
        }
        case 'epub': {
          const r = await exportEpub(db, id);
          if (!r) { console.error('Export failed'); process.exit(1); }
          bytes = r.epub; defaultExt = '.epub';
          outPath ??= r.filename;
          break;
        }
        case 'pdf': {
          const r = await exportPdf(db, id, config.playwrightBrowsersPath, config.captureTimeoutMs);
          if (!r) { console.error('Export failed'); process.exit(1); }
          bytes = r.pdf; defaultExt = '.pdf';
          outPath ??= r.filename;
          break;
        }
        default:
          console.error(`Unknown format: ${fmt}. Use html|md|epub|pdf`);
          process.exit(1);
      }

      if (outPath) {
        mkdirSync(dirname(outPath) || '.', { recursive: true });
        await Bun.write(outPath, bytes);
        console.log(JSON.stringify({ ok: true, output: outPath, bytes: bytes.length }));
      } else {
        // Stdout binary output (pipe-friendly)
        process.stdout.write(bytes);
      }
    } catch (err: any) {
      console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }));
      process.exit(1);
    }
    break;
  }

  // ── delete ───────────────────────────────────────────────────────────────
  case 'delete': {
    const id = Number(args[1]);
    if (!Number.isSafeInteger(id) || id <= 0 || !args.includes('--confirm')) {
      console.error(JSON.stringify({ ok: false, error: 'Usage: packrat delete <id> --confirm' }));
      process.exit(1);
    }
    const impact = getCaptureDeleteImpact(db, id);
    if (!impact) { console.error(JSON.stringify({ ok: false, error: 'Capture not found', id })); process.exit(1); }
    const result = deleteCapture(db, id);
    console.log(JSON.stringify({ ok: true, deleted: result, impact }, null, 2));
    break;
  }

  // ── backup ───────────────────────────────────────────────────────────────
  case 'backup': {
    const dest = args[1];
    if (!dest) { console.error('Usage: packrat backup <destination.sqlite>'); process.exit(1); }
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(JSON.stringify({ ok: true, backup: dest }));
    break;
  }

  // ── verify ───────────────────────────────────────────────────────────────
  case 'verify': {
    const allFlag = args.includes('--all');
    const idIdx = args.indexOf('--id');
    const singleId = idIdx !== -1 ? parseInt(args[idIdx + 1], 10) : null;
    if (!allFlag && !singleId) {
      console.error(JSON.stringify({ ok: false, error: 'Usage: packrat verify --all | --id <N>' }));
      process.exit(1);
    }

    // SQLite integrity check first
    const integrity = db
      .query<{ integrity_check: string }, []>('PRAGMA integrity_check')
      .all();
    const integrityOk = integrity.every((r) => r.integrity_check === 'ok');

    if (!integrityOk) {
      console.error(JSON.stringify({ ok: false, integrityCheck: integrity }));
      process.exit(1);
    }

    // Content-hash verification
    // Never materialise every canonical BLOB in one query. Archive-scale
    // databases can contain gigabytes of bodies, so select IDs first and load
    // exactly one body for hashing at a time.
    const bodyQuery = db.query<{ id: number; content_hash: string | null; html: Uint8Array | null; compression: string }, [number]>(
      'SELECT id, content_hash, html, compression FROM captures WHERE id=?',
    );
    const idBatchQuery = db.query<{ id: number }, [number, number]>(`
      SELECT id FROM captures
      WHERE id > ? AND status='succeeded' AND content_hash IS NOT NULL AND html IS NOT NULL
      ORDER BY id LIMIT ?
    `);

    let ok = 0, fail = 0;
    const failures: Array<{ id: number; expected: string; actual: string }> = [];
    let lastId = 0;
    const ids = singleId ? [singleId] : [];
    while (singleId ? ids.length > 0 : true) {
      const batch = singleId ? ids.splice(0) : idBatchQuery.all(lastId, 100);
      if (batch.length === 0) break;
      for (const entry of batch) {
        const id = typeof entry === 'number' ? entry : entry.id;
        lastId = id;
        const c = bodyQuery.get(id);
        if (!c?.content_hash || !c.html) continue;
      const raw: Buffer =
        c.compression === 'gzip'
          ? Buffer.from(Bun.gunzipSync(Buffer.from(c.html)))
          : Buffer.from(c.html);
      const actual = createHash('sha256').update(raw).digest('hex');
        if (actual === c.content_hash) {
          ok++;
        } else {
          fail++;
          failures.push({ id: c.id, expected: c.content_hash, actual });
        }
      }
    }

    const report = {
      ok: fail === 0,
      integrityCheck: 'passed',
      hashesVerified: ok,
      hashFailures: fail,
      failures: failures.slice(0, 20),
    };
    console.log(JSON.stringify(report, null, 2));
    if (fail > 0) process.exit(1);
    break;
  }

  // ── migrate ───────────────────────────────────────────────────────────────
  case 'migrate': {
    console.log(JSON.stringify({ ok: true, message: 'All migrations applied' }));
    break;
  }

  // ── status ────────────────────────────────────────────────────────────────
  case 'status': {
    const stats = db
      .query<{ total: number; succeeded: number; failed: number; pending: number }, []>(`
        SELECT COUNT(*) as total,
          COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) as succeeded,
          COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) as failed,
          COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) as pending
        FROM captures`)
      .get() ?? { total: 0, succeeded: 0, failed: 0, pending: 0 };

    const jobs = db
      .query<{ queued: number; running: number }, []>(`
        SELECT COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END),0) as queued,
               COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END),0) as running
        FROM jobs WHERE kind='capture'`)
      .get() ?? { queued: 0, running: 0 };

    const pageInfo = db.query<{ page_count: number }, []>('PRAGMA page_count').get() ?? { page_count: 0 };
    const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get() ?? { page_size: 4096 };

    console.log(JSON.stringify({
      ok: true, dbPath: config.dbPath,
      dbSizeMb: ((pageInfo.page_count * pageSize.page_size) / 1024 / 1024).toFixed(2),
      captures: stats, jobs,
    }, null, 2));
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

db.close();

// ─────────────────────────────────────────────────────────────────────────────

function optionValue(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : null;
}

function boundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function summarise(c: any) {
  return {
    id: c.id, title: c.title, mode: c.mode, status: c.status,
    sourceUrl: c.source_url, capturedAt: c.captured_at, htmlSizeBytes: c.html_size,
  };
}

function printHelp(): void {
  console.log(`
bun-packrat — single-file web archive CLI

Usage: bun run src/cli/index.ts <command> [args]

Commands:
  capture <url> [--force]            Archive a URL; --force bypasses freshness reuse
  import archivebox --data-root DIR  Import or resume an ArchiveBox collection
         [--database FILE] [--dry-run|--verify-only] [--retry-failed]
         [--limit N] [--max-candidate-bytes N]
         [--report-json FILE] [--report-html FILE]
  import status                      Show ArchiveBox migration outcomes
  search  <query> [filters]          Full-text search captures
          --domain --tag --mode --status --sort relevance|newest|oldest
  list    [--limit N]                List recent successful captures (default 20)
  export  <id> --format <fmt>        Export a capture
                --format html|md|epub|pdf
                --output <path>      (optional; stdout if omitted)
  delete  <id> --confirm             Permanently delete one capture (JSON output)
  backup  <dest.sqlite>              VACUUM INTO consistent backup
  verify  [--all] [--id <N>]         SQLite integrity + content-hash check
  migrate                            Run pending schema migrations
  status                             Print capture counts and DB size
  help                               Show this help

Environment:
  PACKRAT_DB                   SQLite database path  (./data/packrat.db)
  PORT                         HTTP server port      (3047)
  HOST                         HTTP server host      (0.0.0.0)
  PLAYWRIGHT_BROWSERS_PATH     Browser binaries dir  (/workspace/bin/pw-browsers)
  PACKRAT_CAPTURE_TIMEOUT_MS   Capture timeout ms    (60000)
  PACKRAT_HTML_COMPRESSION     none | gzip           (none)
  PACKRAT_BASE_URL             Service base URL      (http://localhost:3047)
  PACKRAT_FRESHNESS_SECONDS    Recent capture reuse  (86400)
`);
}
