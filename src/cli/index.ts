#!/usr/bin/env bun
/**
 * bun-packrat CLI
 * Usage: bun run src/cli/index.ts <command> [args]
 *
 * Commands:
 *   capture <url>           Capture a URL now (blocking)
 *   search <query>          Search captures
 *   list [--limit N]        List recent captures
 *   backup <dest.sqlite>    Backup the database
 *   migrate                 Run pending migrations
 *   status                  Show database statistics
 */

import { openDatabase, runMigrations, searchCaptures, listCaptures } from '../db/index.js';
import { capturePage } from '../capture/pipeline.js';
import { loadConfig } from '../config.js';

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
  case 'capture': {
    const url = args[1];
    if (!url) {
      console.error('Usage: packrat capture <url>');
      process.exit(1);
    }
    console.error(`[capture] Archiving: ${url}`);
    try {
      const result = await capturePage(url, { config, db });
      const output = {
        ok: true,
        captureId: result.captureId,
        url: `${config.baseUrl}/captures/${result.captureId}`,
        title: result.title,
        mode: result.mode,
        finalUrl: result.finalUrl,
        htmlSize: result.htmlSize,
        contentHash: result.contentHash,
        warnings: result.warnings,
      };
      console.log(JSON.stringify(output, null, 2));
    } catch (err: any) {
      console.error(JSON.stringify({ ok: false, error: err?.message ?? String(err) }, null, 2));
      process.exit(1);
    }
    break;
  }

  case 'search': {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('Usage: packrat search <query>');
      process.exit(1);
    }
    const rows = searchCaptures(db, query, { limit: 50 });
    console.log(JSON.stringify(rows.map(summarise), null, 2));
    break;
  }

  case 'list': {
    const limitIdx = args.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 20;
    const rows = listCaptures(db, { limit });
    console.log(JSON.stringify(rows.map(summarise), null, 2));
    break;
  }

  case 'backup': {
    const dest = args[1];
    if (!dest) {
      console.error('Usage: packrat backup <destination.sqlite>');
      process.exit(1);
    }
    // SQLite VACUUM INTO for a consistent snapshot
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    console.log(JSON.stringify({ ok: true, backup: dest }));
    break;
  }

  case 'migrate': {
    console.error('[migrate] Running pending migrations…');
    // Already ran at startup — just confirm
    console.log(JSON.stringify({ ok: true, message: 'All migrations applied' }));
    break;
  }

  case 'status': {
    const stats = db
      .query<{ total: number; succeeded: number; failed: number; pending: number }, []>(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) as succeeded,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
          SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending
        FROM captures
      `)
      .get() ?? { total: 0, succeeded: 0, failed: 0, pending: 0 };

    const pageInfo = db
      .query<{ page_count: number }, []>('PRAGMA page_count')
      .get() ?? { page_count: 0 };
    const pageSize = db
      .query<{ page_size: number }, []>('PRAGMA page_size')
      .get() ?? { page_size: 4096 };

    const dbBytes = pageInfo.page_count * pageSize.page_size;

    console.log(
      JSON.stringify(
        {
          ok: true,
          dbPath: config.dbPath,
          dbSizeMb: (dbBytes / 1024 / 1024).toFixed(2),
          captures: stats,
        },
        null,
        2,
      ),
    );
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

db.close();

// ---------------------------------------------------------------------------

function summarise(c: any) {
  return {
    id: c.id,
    title: c.title,
    mode: c.mode,
    status: c.status,
    sourceUrl: c.source_url,
    capturedAt: c.captured_at,
    htmlSizeBytes: c.html_size,
  };
}

function printHelp(): void {
  console.log(`
bun-packrat — single-file web archive CLI

Usage: bun run src/cli/index.ts <command> [args]

Commands:
  capture <url>           Archive a URL (blocking)
  search  <query>         Full-text search captures
  list    [--limit N]     List recent successful captures
  backup  <dest.sqlite>   Create a consistent backup via VACUUM INTO
  migrate                 Run pending database migrations
  status                  Print capture counts and database size
  help                    Show this help

Environment:
  PACKRAT_DB              Path to SQLite database  (default: ./data/packrat.db)
  PORT                    HTTP server port         (default: 3047)
  HOST                    HTTP server host         (default: 0.0.0.0)
  PLAYWRIGHT_BROWSERS_PATH  Playwright browser dir (default: /workspace/bin/pw-browsers)
  PACKRAT_CAPTURE_TIMEOUT_MS  Capture timeout ms   (default: 60000)
  PACKRAT_HTML_COMPRESSION    none | gzip          (default: none)
`);
}
