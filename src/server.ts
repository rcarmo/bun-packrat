/**
 * bun-packrat — HTTP server
 * Phase 2: job queue, export routes (HTML/MD/EPUB/PDF), detail page, search UI.
 */

import type { Database } from 'bun:sqlite';
import type { PackratConfig } from './types.js';
import {
  openDatabase, runMigrations,
  getCaptureHtml, getCaptureById, listCaptures, searchCaptures,
  getCaptureTags, addTagToCapture, listTags, getJobById,
  createJob, getOrCreateUrl, insertCapture,
} from './db/index.js';
import { JobQueue } from './queue/index.js';
import { exportHtml, slugify } from './export/html.js';
import { exportMarkdownZip } from './export/markdown.js';
import { exportEpub } from './export/epub.js';
import { exportPdf } from './export/pdf.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const db = openDatabase(config.dbPath);
runMigrations(db);

// Start job queue
const queue = new JobQueue({ db, config });
queue.start();

// Graceful shutdown
process.on('SIGTERM', () => { queue.stop(); db.close(); process.exit(0); });
process.on('SIGINT',  () => { queue.stop(); db.close(); process.exit(0); });

const server = Bun.serve({
  port: config.port,
  hostname: config.host,

  async fetch(req) {
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // ── Static index ──────────────────────────────────────────────────────
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return renderIndex(db, url);
    }

    // ── Capture detail ────────────────────────────────────────────────────
    const detailMatch = path.match(/^\/captures\/(\d+)$/);
    if (method === 'GET' && detailMatch) {
      const id = parseInt(detailMatch[1], 10);
      const acceptsHtml = (req.headers.get('accept') ?? '').includes('text/html');
      // JSON API
      if (!acceptsHtml || url.searchParams.has('meta')) {
        const c = getCaptureById(db, id);
        if (!c) return json404();
        return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, id) });
      }
      return serveCaptureHtml(db, id);
    }

    // ── Exports ───────────────────────────────────────────────────────────
    const exportMatch = path.match(/^\/captures\/(\d+)\/export\/(html|md|epub|pdf)$/);
    if (method === 'GET' && exportMatch) {
      const id = parseInt(exportMatch[1], 10);
      const fmt = exportMatch[2];
      return handleExport(db, id, fmt, config);
    }

    // ── Tags on a capture ─────────────────────────────────────────────────
    const tagMatch = path.match(/^\/api\/captures\/(\d+)\/tags$/);
    if (tagMatch) {
      const id = parseInt(tagMatch[1], 10);
      if (method === 'GET') {
        return Response.json({ tags: getCaptureTags(db, id) });
      }
      if (method === 'POST') {
        const body = await safeJson(req);
        const tag = body?.tag?.trim();
        if (!tag) return Response.json({ error: '"tag" is required' }, { status: 400 });
        addTagToCapture(db, id, tag);
        return Response.json({ ok: true, tag });
      }
    }

    // ── Tags index ────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/tags') {
      return Response.json({ tags: listTags(db) });
    }

    // ── API: list / search captures ───────────────────────────────────────
    if (method === 'GET' && path === '/api/captures') {
      const q      = url.searchParams.get('q') ?? '';
      const limit  = clamp(parseInt(url.searchParams.get('limit')  ?? '50', 10), 1, 200);
      const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));
      const rows   = q.trim()
        ? searchCaptures(db, q, { limit, offset })
        : listCaptures(db, { limit, offset });
      return Response.json({ captures: rows.map(summariseCapture) });
    }

    // ── API: get single capture metadata ──────────────────────────────────
    const apiCapMatch = path.match(/^\/api\/captures\/(\d+)$/);
    if (method === 'GET' && apiCapMatch) {
      const c = getCaptureById(db, parseInt(apiCapMatch[1], 10));
      if (!c) return json404();
      return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, c.id) });
    }

    // ── API: submit capture (queue a job) ────────────────────────────────
    if (method === 'POST' && path === '/api/captures') {
      const body = await safeJson(req);
      const rawUrl = body?.url;
      if (!rawUrl || typeof rawUrl !== 'string') {
        return Response.json({ error: '"url" field is required' }, { status: 400 });
      }
      const jobId = createJob(db, 'capture', { url: rawUrl });
      return Response.json({ message: 'Capture queued', jobId, url: rawUrl }, { status: 202 });
    }

    // ── API: job status ───────────────────────────────────────────────────
    const jobMatch = path.match(/^\/api\/jobs\/(\d+)$/);
    if (method === 'GET' && jobMatch) {
      const job = getJobById(db, parseInt(jobMatch[1], 10));
      if (!job) return json404();
      return Response.json(job);
    }

    // ── Status ────────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/status') {
      return Response.json(buildStatus(db, queue));
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

// ────────────────────────────────────────────────────────────────────────────
// Export dispatcher
// ────────────────────────────────────────────────────────────────────────────

async function handleExport(
  db: Database,
  id: number,
  fmt: string,
  config: PackratConfig,
): Promise<Response> {
  switch (fmt) {
    case 'html': {
      const r = await exportHtml(db, id);
      if (!r) return json404('Capture not found or not yet succeeded');
      return new Response(r.html, {
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Disposition': `attachment; filename="${r.filename}"`,
          'Content-Security-Policy': csp(),
        },
      });
    }
    case 'md': {
      const r = await exportMarkdownZip(db, id);
      if (!r) return json404('Capture not found or not yet succeeded');
      return new Response(r.zip, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${r.filename}"`,
        },
      });
    }
    case 'epub': {
      const r = await exportEpub(db, id);
      if (!r) return json404('Capture not found or not yet succeeded');
      return new Response(r.epub, {
        headers: {
          'Content-Type': 'application/epub+zip',
          'Content-Disposition': `attachment; filename="${r.filename}"`,
        },
      });
    }
    case 'pdf': {
      try {
        const r = await exportPdf(db, id, config.playwrightBrowsersPath, config.captureTimeoutMs);
        if (!r) return json404('Capture not found or not yet succeeded');
        return new Response(r.pdf, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="${r.filename}"`,
          },
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err?.message ?? 'PDF generation failed' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    default:
      return new Response('Unknown format', { status: 400 });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// HTML rendering
// ────────────────────────────────────────────────────────────────────────────

async function serveCaptureHtml(db: Database, id: number): Promise<Response> {
  const row = getCaptureHtml(db, id);
  if (!row?.html) return new Response('Capture not found', { status: 404 });

  let html: Buffer;
  if (row.compression === 'gzip') {
    html = Buffer.from(Bun.gunzipSync(row.html as unknown as Uint8Array));
  } else {
    html = Buffer.from(row.html as unknown as Uint8Array);
  }

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': csp(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

async function renderIndex(db: Database, url: URL): Promise<Response> {
  const q      = url.searchParams.get('q') ?? '';
  const domain = url.searchParams.get('domain') ?? '';
  const tag    = url.searchParams.get('tag') ?? '';
  const limit  = 50;
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10));

  let rows = q.trim()
    ? searchCaptures(db, q, { limit, offset })
    : listCaptures(db, { limit, offset });

  if (domain) rows = rows.filter((c) => getDomain(c.source_url) === domain);
  if (tag) {
    const tagged = new Set(
      db.query<{ capture_id: number }, [string]>(
        'SELECT ct.capture_id FROM capture_tags ct JOIN tags t ON t.id = ct.tag_id WHERE t.name = ?',
      ).all(tag).map((r) => r.capture_id),
    );
    rows = rows.filter((c) => tagged.has(c.id));
  }

  const totalCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status='succeeded'`)
    .get()?.n ?? 0;

  const tags = listTags(db).slice(0, 20);

  const tagCloud = tags.length
    ? `<div class="tag-cloud">${tags.map((t) =>
        `<a class="tag${tag === t.name ? ' active' : ''}" href="/?tag=${esc(t.name)}">${esc(t.name)} <span>${t.count}</span></a>`
      ).join('')}</div>`
    : '';

  const items = rows.map((c) => `
    <li class="item">
      <div class="item-title"><a href="/captures/${c.id}">${esc(c.title ?? '(no title)')}</a></div>
      <div class="item-meta">
        <a class="domain" href="/?domain=${esc(getDomain(c.source_url))}">${esc(getDomain(c.source_url))}</a>
        <span class="mode">${esc(c.mode)}</span>
        <span class="date">${esc(c.captured_at?.slice(0, 10) ?? '')}</span>
        <a class="source-link" href="${esc(c.source_url)}" rel="noopener" target="_blank">↗</a>
        <a class="export-link" href="/captures/${c.id}/export/html" title="Download HTML">⬇ HTML</a>
        <a class="export-link" href="/captures/${c.id}/export/md"   title="Download Markdown ZIP">MD</a>
        <a class="export-link" href="/captures/${c.id}/export/epub" title="Download EPUB">EPUB</a>
        <a class="export-link" href="/captures/${c.id}/export/pdf"  title="Download PDF">PDF</a>
      </div>
      ${c.excerpt ? `<div class="item-excerpt">${esc(c.excerpt.slice(0, 200))}</div>` : ''}
    </li>`).join('');

  const prevHref = offset > 0 ? `/?q=${esc(q)}&offset=${Math.max(0, offset - limit)}` : null;
  const nextHref = rows.length === limit ? `/?q=${esc(q)}&offset=${offset + limit}` : null;
  const pagination = (prevHref || nextHref)
    ? `<div class="pagination">${prevHref ? `<a href="${prevHref}">← Previous</a>` : ''} ${nextHref ? `<a href="${nextHref}">Next →</a>` : ''}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Packrat Archive</title>
<style>
:root{--bg:#fff;--fg:#1a1a1a;--muted:#666;--border:#ddd;--accent:#0057b7;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#1a1a1a;--fg:#e8e8e8;--muted:#aaa;--border:#444;--accent:#5da9ff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.5}
header{border-bottom:1px solid var(--border);padding:.8rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header h1{margin:0;font-size:1.2rem;white-space:nowrap}
form{display:flex;gap:.4rem;flex:1;min-width:200px}
input[type=search]{flex:1;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:.95rem}
button{padding:.4rem .8rem;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer}
.capture-form{border-bottom:1px solid var(--border);padding:.5rem 1rem;display:flex;gap:.4rem;flex-wrap:wrap}
.capture-form input{flex:1;min-width:200px;padding:.35rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:.9rem}
.capture-form button{background:#2a7d4f;font-size:.85rem}
.count{color:var(--muted);font-size:.82rem;padding:.3rem 1rem;border-bottom:1px solid var(--border)}
.tag-cloud{padding:.4rem 1rem .3rem;display:flex;flex-wrap:wrap;gap:.3rem;border-bottom:1px solid var(--border)}
.tag{font-size:.78rem;padding:.15rem .4rem;border-radius:12px;background:var(--border);color:var(--fg);text-decoration:none;display:inline-flex;gap:.3em;align-items:center}
.tag.active{background:var(--accent);color:#fff}
.tag span{opacity:.7;font-size:.9em}
ul{list-style:none;margin:0;padding:0}
.item{padding:.7rem 1rem;border-bottom:1px solid var(--border)}
.item-title a{font-weight:600;color:var(--fg);text-decoration:none}
.item-title a:hover{color:var(--accent)}
.item-meta{font-size:.78rem;color:var(--muted);margin-top:.2rem;display:flex;gap:.6rem;flex-wrap:wrap;align-items:center}
.item-meta a{color:var(--muted);text-decoration:none}
.item-meta a:hover{color:var(--accent)}
.domain{font-weight:500}
.export-link{font-size:.72rem;padding:.1rem .3rem;border:1px solid var(--border);border-radius:3px}
.item-excerpt{font-size:.82rem;color:var(--muted);margin-top:.3rem;line-height:1.4}
.pagination{padding:.8rem 1rem;display:flex;gap:1rem;font-size:.9rem}
.pagination a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>📦 Packrat</h1>
  <form method="GET" action="/">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search archives…" autocomplete="off">
    <button type="submit">Search</button>
  </form>
</header>
<form class="capture-form" id="capture-form">
  <input type="url" id="capture-url" placeholder="Archive a URL…" required>
  <button type="submit">Archive</button>
  <span id="capture-status" style="font-size:.82rem;color:var(--muted);padding:.3rem 0"></span>
</form>
${tagCloud}
<p class="count">${totalCount.toLocaleString()} archive${totalCount === 1 ? '' : 's'}${q ? ` matching "${esc(q)}"` : ''}${domain ? ` from ${esc(domain)}` : ''}${tag ? ` tagged ${esc(tag)}` : ''}</p>
<ul>${items || '<li style="padding:1rem;color:var(--muted)">No captures yet.</li>'}</ul>
${pagination}
<script>
document.getElementById('capture-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('capture-url').value.trim();
  const status = document.getElementById('capture-status');
  if (!url) return;
  status.textContent = 'Queuing…';
  try {
    const r = await fetch('/api/captures', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({url}) });
    const d = await r.json();
    if (r.ok) { status.textContent = 'Queued ✓ (job #' + d.jobId + ')'; document.getElementById('capture-url').value = ''; }
    else { status.textContent = 'Error: ' + (d.error ?? r.status); }
  } catch(err) { status.textContent = 'Network error'; }
});
</script>
</body>
</html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildStatus(db: Database, queue: JobQueue) {
  const stats = db
    .query<{ total: number; succeeded: number; failed: number; pending: number }, []>(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) as succeeded,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) as pending
      FROM captures`)
    .get() ?? { total: 0, succeeded: 0, failed: 0, pending: 0 };

  const jobs = db
    .query<{ queued: number; running: number }, []>(`
      SELECT SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) as queued,
             SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) as running
      FROM jobs WHERE kind='capture'`)
    .get() ?? { queued: 0, running: 0 };

  const pageInfo = db.query<{ page_count: number }, []>('PRAGMA page_count').get() ?? { page_count: 0 };
  const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get() ?? { page_size: 4096 };

  return {
    status: 'ok',
    captures: stats,
    jobQueue: { queued: jobs.queued, running: jobs.running, activeWorkers: queue.activeCount },
    dbSizeMb: ((pageInfo.page_count * pageSize.page_size) / 1024 / 1024).toFixed(2),
  };
}

function summariseCapture(c: any) {
  return {
    id: c.id, title: c.title, mode: c.mode, status: c.status,
    sourceUrl: c.source_url, finalUrl: c.final_url,
    capturedAt: c.captured_at, htmlSizeBytes: c.html_size,
    excerpt: c.excerpt, contentHash: c.content_hash,
  };
}

function getDomain(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function esc(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function csp(): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src data:",
    "font-src data:",
  ].join('; ');
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function json404(msg = 'Not found'): Response {
  return Response.json({ error: msg }, { status: 404 });
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  try { return await req.json(); } catch { return null; }
}
