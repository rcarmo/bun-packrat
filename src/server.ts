/**
 * bun-packrat — HTTP server
 * Phase 1: captures/:id viewer + POST /api/captures submission.
 */

import type { Database } from 'bun:sqlite';
import type { PackratConfig } from './types.js';
import { openDatabase, runMigrations, getCaptureHtml, listCaptures, searchCaptures, insertCapture, getOrCreateUrl } from './db/index.js';
import { capturePage } from './capture/pipeline.js';
import { loadConfig } from './config.js';
import { zlib } from 'bun';

const config = loadConfig();
const db = openDatabase(config.dbPath);
runMigrations(db);

const CAPTURE_QUEUE: Promise<any>[] = [];
let activeCaptureCount = 0;

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // ---------- Static: index ----------
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return renderIndex(db, url);
    }

    // ---------- Captures: view ----------
    const captureMatch = path.match(/^\/captures\/(\d+)$/);
    if (method === 'GET' && captureMatch) {
      return serveCaptureHtml(db, parseInt(captureMatch[1], 10));
    }

    // ---------- API: list / search ----------
    if (method === 'GET' && path === '/api/captures') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
      const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

      const rows = q.trim()
        ? searchCaptures(db, q, { limit, offset })
        : listCaptures(db, { limit, offset });

      return Response.json({ captures: rows.map(summariseCapture) });
    }

    // ---------- API: submit capture ----------
    if (method === 'POST' && path === '/api/captures') {
      let body: any;
      try {
        body = await req.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }

      const rawUrl = body?.url;
      if (!rawUrl || typeof rawUrl !== 'string') {
        return Response.json({ error: '"url" field is required' }, { status: 400 });
      }

      if (activeCaptureCount >= config.maxConcurrentCaptures) {
        return Response.json(
          { error: 'Capture queue is full; try again shortly' },
          { status: 503 },
        );
      }

      activeCaptureCount++;
      const task = capturePage(rawUrl, { config, db })
        .then((result) => {
          return result;
        })
        .catch((err) => {
          console.error(JSON.stringify({ event: 'capture.error', error: err?.message }));
        })
        .finally(() => {
          activeCaptureCount--;
        });

      CAPTURE_QUEUE.push(task);

      // Async — return immediately with 202 Accepted
      return Response.json(
        { message: 'Capture queued', url: rawUrl },
        { status: 202 },
      );
    }

    // ---------- Status ----------
    if (method === 'GET' && path === '/api/status') {
      const stats = db
        .query<{ total: number; succeeded: number; failed: number }, []>(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) as succeeded,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
          FROM captures
        `)
        .get() ?? { total: 0, succeeded: 0, failed: 0 };

      const dbSize = db
        .query<{ page_count: number; page_size: number }, []>(
          'PRAGMA page_count; PRAGMA page_size;',
        )
        .all();

      return Response.json({
        status: 'ok',
        captures: stats,
        activeCaptures: activeCaptureCount,
        dbPath: config.dbPath,
      });
    }

    return new Response('Not found', { status: 404 });
  },
});

console.log(
  JSON.stringify({
    event: 'server.started',
    url: `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`,
    db: config.dbPath,
  }),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function serveCaptureHtml(db: Database, id: number): Promise<Response> {
  const row = getCaptureHtml(db, id);
  if (!row) {
    return new Response('Capture not found', { status: 404 });
  }

  let html: Buffer;
  if (!row.html) {
    return new Response('No HTML stored for this capture', { status: 404 });
  }

  if (row.compression === 'gzip') {
    html = Buffer.from(await Bun.gunzipSync(row.html as unknown as Uint8Array));
  } else {
    html = row.html as unknown as Buffer;
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src data:",
        "font-src data:",
      ].join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function renderIndex(db: Database, url: URL): Promise<Response> {
  const q = url.searchParams.get('q') ?? '';
  const limit = 50;
  const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);

  const rows = q.trim()
    ? searchCaptures(db, q, { limit, offset })
    : listCaptures(db, { limit, offset });

  const totalCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status = 'succeeded'`)
    .get()?.n ?? 0;

  const items = rows
    .map(
      (c) => `
    <li class="item">
      <div class="item-title">
        <a href="/captures/${c.id}">${esc(c.title ?? '(no title)')}</a>
      </div>
      <div class="item-meta">
        <span class="domain">${esc(getDomain(c.source_url))}</span>
        <span class="mode">${esc(c.mode)}</span>
        <span class="date">${esc(c.captured_at?.slice(0, 10) ?? '')}</span>
        <a class="source-link" href="${esc(c.source_url)}" rel="noopener" target="_blank">↗ source</a>
      </div>
      ${c.excerpt ? `<div class="item-excerpt">${esc(c.excerpt.slice(0, 200))}</div>` : ''}
    </li>`,
    )
    .join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Packrat Archive</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--border:#ddd;--accent:#0057b7;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--fg:#e8e8e8;--muted:#aaa;--border:#444;--accent:#5da9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.5}
header{border-bottom:1px solid var(--border);padding:.8rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header h1{margin:0;font-size:1.2rem}
form{display:flex;gap:.5rem;flex:1;min-width:200px}
input[type=search]{flex:1;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:.95rem}
button{padding:.4rem .8rem;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:.9rem}
.count{color:var(--muted);font-size:.85rem;padding:0 1rem .4rem}
ul{list-style:none;margin:0;padding:0}
.item{padding:.75rem 1rem;border-bottom:1px solid var(--border)}
.item-title a{font-weight:600;color:var(--fg);text-decoration:none;font-size:1rem}
.item-title a:hover{color:var(--accent)}
.item-meta{font-size:.8rem;color:var(--muted);margin-top:.2rem;display:flex;gap:.8rem;flex-wrap:wrap}
.item-meta a{color:var(--muted)}
.item-excerpt{font-size:.85rem;color:var(--muted);margin-top:.3rem}
</style>
</head>
<body>
<header>
  <h1>📦 Packrat</h1>
  <form method="GET" action="/">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search…" autocomplete="off">
    <button type="submit">Search</button>
  </form>
</header>
<p class="count">${totalCount.toLocaleString()} archive${totalCount === 1 ? '' : 's'}${q ? ` matching "${esc(q)}"` : ''}</p>
<ul>${items || '<li style="padding:1rem;color:var(--muted)">No captures yet. Submit a URL via <code>POST /api/captures</code>.</li>'}</ul>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function summariseCapture(c: any) {
  return {
    id: c.id,
    title: c.title,
    sourceUrl: c.source_url,
    finalUrl: c.final_url,
    mode: c.mode,
    status: c.status,
    capturedAt: c.captured_at,
    htmlSize: c.html_size,
    excerpt: c.excerpt,
  };
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
