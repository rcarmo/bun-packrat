/**
 * bun-packrat — HTTP server
 * Phase 2: job queue, export routes (HTML/MD/EPUB/PDF), detail page, search UI.
 */

import type { Database } from 'bun:sqlite';
import type { PackratConfig, CaptureRow } from './types.js';
import {
  openDatabase, runMigrations,
  getCaptureHtml, getCaptureById, listCaptures, searchCaptures,
  getCaptureTags, addTagToCapture, listTags, getJobById, getJobAttempts,
  createJob, getCaptureAliases, updateCaptureNote, cancelJob,
} from './db/index.js';
import { JobQueue } from './queue/index.js';
import { exportHtml, slugify } from './export/html.js';
import { exportMarkdownZip } from './export/markdown.js';
import { exportEpub } from './export/epub.js';
import { exportPdf } from './export/pdf.js';
import { loadConfig } from './config.js';

const config = loadConfig();
if (!config.authDisabled && !config.authPassword) {
  throw new Error('Set PACKRAT_AUTH_PASSWORD or explicitly set PACKRAT_AUTH_DISABLED=1');
}
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
    if (!isAuthorised(req, config)) return authRequired();
    if (!isSameOriginMutation(req, url)) {
      return Response.json({ error: 'Cross-origin mutation rejected' }, { status: 403 });
    }
    const method = req.method;
    const path = url.pathname;

    // ── Static index ──────────────────────────────────────────────────────
    if (method === 'GET' && (path === '/' || path === '/index.html')) {
      return renderIndex(db, url);
    }

    if (method === 'GET' && path === '/bookmarklet.js') {
      const js = `location.href=${JSON.stringify(config.baseUrl.replace(/\/$/, '') + '/?archive=')}+encodeURIComponent(location.href);`;
      return new Response(js, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' } });
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
        return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, id), aliases: getCaptureAliases(db, id) });
      }
      return serveCaptureHtml(db, id);
    }

    const recaptureMatch = path.match(/^\/api\/captures\/(\d+)\/recapture$/);
    if (method === 'POST' && recaptureMatch) {
      const capture = getCaptureById(db, parseInt(recaptureMatch[1], 10));
      if (!capture) return json404('Capture not found');
      const jobId = createJob(db, 'capture', { url: capture.source_url, force: true });
      return Response.json({ message: 'Recapture queued', jobId, url: capture.source_url }, { status: 202 });
    }

    const noteMatch = path.match(/^\/api\/captures\/(\d+)\/note$/);
    if (method === 'PUT' && noteMatch) {
      const id = parseInt(noteMatch[1], 10);
      if (!getCaptureById(db, id)) return json404('Capture not found');
      const body = await safeJson(req);
      const noteValue = body?.note;
      if (noteValue != null && typeof noteValue !== 'string') {
        return Response.json({ error: '"note" must be a string or null' }, { status: 400 });
      }
      const note = typeof noteValue === 'string' ? noteValue.trim().slice(0, 10_000) : null;
      updateCaptureNote(db, id, note || null);
      return Response.json({ ok: true, note: note || null });
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
        if (!getCaptureById(db, id)) return json404('Capture not found');
        const body = await safeJson(req);
        const tagValue = body?.tag;
        const tag = typeof tagValue === 'string' ? tagValue.trim() : '';
        if (!tag) return Response.json({ error: '"tag" is required' }, { status: 400 });
        try {
          addTagToCapture(db, id, tag);
        } catch (err: any) {
          return Response.json({ error: err?.message ?? 'Invalid tag' }, { status: 400 });
        }
        return Response.json({ ok: true, tag });
      }
    }

    // ── Tags index ────────────────────────────────────────────────────────
    if (method === 'GET' && path === '/api/tags') {
      return Response.json({ tags: listTags(db) });
    }

    // ── API: list / search captures ───────────────────────────────────────
    if (method === 'GET' && path === '/api/captures') {
      const q = url.searchParams.get('q') ?? '';
      const limit = parseBoundedInt(url.searchParams.get('limit'), 50, 1, 200);
      const offset = parseBoundedInt(url.searchParams.get('offset'), 0, 0, 1_000_000);
      const filters = captureQueryOptions(url, limit, offset);
      try {
        const rows = q.trim()
          ? searchCaptures(db, q, filters)
          : listCaptures(db, filters);
        return Response.json({ captures: rows.map(summariseCapture) });
      } catch (err: any) {
        return Response.json({ error: `Invalid search query: ${err?.message ?? err}` }, { status: 400 });
      }
    }

    // ── API: get single capture metadata ──────────────────────────────────
    const apiCapMatch = path.match(/^\/api\/captures\/(\d+)$/);
    if (method === 'GET' && apiCapMatch) {
      const c = getCaptureById(db, parseInt(apiCapMatch[1], 10));
      if (!c) return json404();
      return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, c.id), aliases: getCaptureAliases(db, c.id) });
    }

    // ── API: submit capture (queue a job) ────────────────────────────────
    if (method === 'POST' && path === '/api/captures') {
      const body = await safeJson(req);
      const rawUrl = body?.url;
      if (!rawUrl || typeof rawUrl !== 'string' || rawUrl.length > 8192) {
        return Response.json({ error: '"url" field is required' }, { status: 400 });
      }
      const idempotencyKey = req.headers.get('idempotency-key')?.trim() || undefined;
      if (idempotencyKey && idempotencyKey.length > 200) {
        return Response.json({ error: 'Idempotency-Key is too long' }, { status: 400 });
      }
      const jobId = createJob(db, 'capture', { url: rawUrl, force: body?.force === true }, idempotencyKey);
      return Response.json({ message: 'Capture queued', jobId, url: rawUrl }, { status: 202 });
    }

    // ── API: job status ───────────────────────────────────────────────────
    const jobMatch = path.match(/^\/api\/jobs\/(\d+)$/);
    if (jobMatch) {
      const id = parseInt(jobMatch[1], 10);
      if (method === 'GET') {
        const job = getJobById(db, id);
        if (!job) return json404();
        return Response.json({ ...job, attempts: getJobAttempts(db, job.id) });
      }
      if (method === 'DELETE') {
        return cancelJob(db, id)
          ? Response.json({ ok: true, status: 'cancelled' })
          : Response.json({ error: 'Only queued jobs can be cancelled' }, { status: 409 });
      }
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
      return new Response(new Blob([Uint8Array.from(r.html).buffer]), {
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
      return new Response(new Blob([Uint8Array.from(r.zip).buffer]), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${r.filename}"`,
        },
      });
    }
    case 'epub': {
      const r = await exportEpub(db, id);
      if (!r) return json404('Capture not found or not yet succeeded');
      return new Response(new Blob([Uint8Array.from(r.epub).buffer]), {
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
        return new Response(new Blob([Uint8Array.from(r.pdf).buffer]), {
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
    html = Buffer.from(Bun.gunzipSync(Buffer.from(row.html)));
  } else {
    html = Buffer.from(row.html as unknown as Uint8Array);
  }

  return new Response(new Blob([Uint8Array.from(html).buffer]), {
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
  const archive = url.searchParams.get('archive') ?? '';
  const q      = url.searchParams.get('q') ?? '';
  const domain = url.searchParams.get('domain') ?? '';
  const tag    = url.searchParams.get('tag') ?? '';
  const mode   = url.searchParams.get('mode') ?? '';
  const sort   = url.searchParams.get('sort') ?? (q ? 'relevance' : 'newest');
  const limit  = 50;
  const offset = parseBoundedInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  const filters = captureQueryOptions(url, limit, offset);
  let rows: CaptureRow[];
  try {
    rows = q.trim()
      ? searchCaptures(db, q, filters)
      : listCaptures(db, filters);
  } catch {
    rows = [];
  }

  const totalCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status='succeeded'`)
    .get()?.n ?? 0;
  const failedCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status='failed'`)
    .get()?.n ?? 0;

  const tags = listTags(db).slice(0, 20);

  const tagCloud = tags.length
    ? `<div class="tag-cloud">${tags.map((t) =>
        `<a class="tag${tag === t.name ? ' active' : ''}" href="/?tag=${encodeURIComponent(t.name)}">${esc(t.name)} <span>${t.count}</span></a>`
      ).join('')}</div>`
    : '';

  const items = rows.map((c) => `
    <li class="item">
      <div class="item-title"><a href="/captures/${c.id}">${esc(c.title ?? '(no title)')}</a></div>
      <div class="item-meta">
        <a class="domain" href="/?domain=${encodeURIComponent(getDomain(c.source_url))}">${esc(getDomain(c.source_url))}</a>
        <span class="mode">${esc(c.mode)}</span>
        <span class="date">${esc(c.captured_at?.slice(0, 10) ?? '')}</span>
        ${c.warnings ? '<span class="warnings" title="Capture has warnings">⚠</span>' : ''}
        <a class="source-link" href="${esc(c.source_url)}" rel="noopener" target="_blank">↗</a>
        <a class="export-link" href="/captures/${c.id}/export/html" title="Download HTML">⬇ HTML</a>
        <a class="export-link" href="/captures/${c.id}/export/md"   title="Download Markdown ZIP">MD</a>
        <a class="export-link" href="/captures/${c.id}/export/epub" title="Download EPUB">EPUB</a>
        <a class="export-link" href="/captures/${c.id}/export/pdf"  title="Download PDF">PDF</a>
        <button class="recapture" data-id="${c.id}" type="button" title="Capture again now">↻</button>
      </div>
      ${c.warnings ? `<details class="capture-warnings"><summary>Capture warnings</summary><ul>${parseWarnings(c.warnings).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${c.error ? `<div class="capture-error">${esc(c.error)}</div>` : ''}
      ${c.excerpt ? `<div class="item-excerpt">${esc(c.excerpt.slice(0, 200))}</div>` : ''}
    </li>`).join('');

  const queryBase = new URLSearchParams();
  if (q) queryBase.set('q', q);
  if (domain) queryBase.set('domain', domain);
  if (tag) queryBase.set('tag', tag);
  const pageHref = (nextOffset: number) => {
    const params = new URLSearchParams(queryBase);
    params.set('offset', String(nextOffset));
    return `/?${params.toString()}`;
  };
  const prevHref = offset > 0 ? pageHref(Math.max(0, offset - limit)) : null;
  const nextHref = rows.length === limit ? pageHref(offset + limit) : null;
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
input[type=search]{flex:1;padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg);font-size:.95rem}select{padding:.4rem;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--fg)}
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
.export-link{font-size:.72rem;padding:.1rem .3rem;border:1px solid var(--border);border-radius:3px}.recapture{font-size:.72rem;padding:.1rem .35rem;background:transparent;color:var(--muted);border:1px solid var(--border)}
.item-excerpt{font-size:.82rem;color:var(--muted);margin-top:.3rem;line-height:1.4}.capture-warnings,.capture-error{font-size:.78rem;color:#9a6700;margin-top:.3rem}.capture-warnings ul{list-style:disc;padding-left:1.2rem}.capture-error{color:#b42318}
.pagination{padding:.8rem 1rem;display:flex;gap:1rem;font-size:.9rem}
.pagination a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>📦 Packrat</h1>
  <form method="GET" action="/">
    <input type="search" name="q" value="${esc(q)}" placeholder="Search archives…" autocomplete="off">
    <select name="mode" aria-label="Capture mode"><option value=""${!mode ? ' selected' : ''}>All modes</option><option value="article"${mode === 'article' ? ' selected' : ''}>Article</option><option value="full_page"${mode === 'full_page' ? ' selected' : ''}>Full page</option><option value="metadata_only"${mode === 'metadata_only' ? ' selected' : ''}>Metadata only</option></select>
    <select name="sort" aria-label="Sort"><option value="relevance"${sort === 'relevance' ? ' selected' : ''}>Relevance</option><option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest</option><option value="oldest"${sort === 'oldest' ? ' selected' : ''}>Oldest</option></select>
    <button type="submit">Search</button>
  </form>
</header>
<form class="capture-form" id="capture-form">
  <input type="url" id="capture-url" value="${esc(archive)}" placeholder="Archive a URL…" required>
  <button type="submit">Archive</button>
  <span id="capture-status" style="font-size:.82rem;color:var(--muted);padding:.3rem 0"></span>
</form>
${tagCloud}
<p class="count">${totalCount.toLocaleString()} archive${totalCount === 1 ? '' : 's'} · <a href="/?status=failed">${failedCount} failed capture${failedCount === 1 ? '' : 's'}</a>${q ? ` matching "${esc(q)}"` : ''}${domain ? ` from ${esc(domain)}` : ''}${tag ? ` tagged ${esc(tag)}` : ''}</p>
<ul>${items || '<li style="padding:1rem;color:var(--muted)">No captures yet.</li>'}</ul>
${pagination}
<script>
document.querySelectorAll('.recapture').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  const r = await fetch('/api/captures/' + button.dataset.id + '/recapture', {method:'POST'});
  button.textContent = r.ok ? '✓' : '!';
}));
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

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

function buildStatus(db: Database, queue: JobQueue) {
  const stats = db
    .query<{ total: number; succeeded: number; failed: number; pending: number }, []>(`
      SELECT COUNT(*) as total,
        COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END), 0) as succeeded,
        COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END), 0) as failed,
        COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END), 0) as pending
      FROM captures`)
    .get() ?? { total: 0, succeeded: 0, failed: 0, pending: 0 };

  const jobs = db
    .query<{ queued: number; running: number }, []>(`
      SELECT COALESCE(SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END), 0) as queued,
             COALESCE(SUM(CASE WHEN status='running' THEN 1 ELSE 0 END), 0) as running
      FROM jobs WHERE kind='capture'`)
    .get() ?? { queued: 0, running: 0 };

  const pageInfo = db.query<{ page_count: number }, []>('PRAGMA page_count').get() ?? { page_count: 0 };
  const pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get() ?? { page_size: 4096 };

  return {
    status: 'ok',
    captures: stats,
    jobQueue: { queued: jobs.queued, running: jobs.running, activeWorkers: queue.activeCount },
    captureDurationMs: db.query<{ average: number; p95: number }, []>(`
      SELECT COALESCE(AVG(capture_duration_ms),0) average,
             COALESCE(MAX(capture_duration_ms),0) p95
      FROM (SELECT capture_duration_ms FROM captures WHERE status='succeeded' AND capture_duration_ms IS NOT NULL ORDER BY capture_duration_ms LIMIT MAX(1, CAST((SELECT COUNT(*) * 0.95 FROM captures WHERE status='succeeded' AND capture_duration_ms IS NOT NULL) AS INTEGER)))
    `).get(),
    importCounts: db.query<{ total: number }, []>('SELECT COUNT(*) total FROM archivebox_imports').get(),
    dbSizeMb: ((pageInfo.page_count * pageSize.page_size) / 1024 / 1024).toFixed(2),
  };
}

function summariseCapture(c: any) {
  return {
    id: c.id, title: c.title, mode: c.mode, status: c.status,
    sourceUrl: c.source_url, finalUrl: c.final_url,
    capturedAt: c.captured_at, htmlSizeBytes: c.html_size,
    excerpt: c.excerpt, contentHash: c.content_hash,
    author: c.author, siteName: c.site_name, publishedAt: c.published_at,
    warnings: parseWarnings(c.warnings), error: c.error, note: c.note,
    captureTool: c.capture_tool, captureDurationMs: c.capture_duration_ms,
  };
}

function captureQueryOptions(url: URL, limit: number, offset: number) {
  const sortRaw = url.searchParams.get('sort');
  const sort = sortRaw === 'oldest' || sortRaw === 'relevance' ? sortRaw : 'newest';
  return {
    limit, offset, sort,
    status: url.searchParams.get('status') ?? undefined,
    mode: url.searchParams.get('mode') ?? undefined,
    domain: url.searchParams.get('domain') ?? undefined,
    title: url.searchParams.get('title') ?? undefined,
    tag: url.searchParams.get('tag') ?? undefined,
    url: url.searchParams.get('url') ?? undefined,
    dateFrom: url.searchParams.get('dateFrom') ?? undefined,
    dateTo: url.searchParams.get('dateTo') ?? undefined,
  } as const;
}

function parseWarnings(value: string | null): string[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : [value]; }
  catch { return [value]; }
}

function isAuthorised(req: Request, config: PackratConfig): boolean {
  if (config.authDisabled) return true;
  if (!config.authPassword) return false;
  const header = req.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return false;
  try {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf-8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return false;
    return timingSafeEqual(decoded.slice(0, separator), config.authUser) &&
      timingSafeEqual(decoded.slice(separator + 1), config.authPassword);
  } catch { return false; }
}

function timingSafeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return require('crypto').timingSafeEqual(aa, bb);
}

function authRequired(): Response {
  return Response.json({ error: 'Authentication required' }, {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Packrat", charset="UTF-8"' },
  });
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
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function parseBoundedInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function json404(msg = 'Not found'): Response {
  return Response.json({ error: msg }, { status: 404 });
}

function isSameOriginMutation(req: Request, url: URL): boolean {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return true;
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) return false;
  const fetchSite = req.headers.get('sec-fetch-site');
  return !fetchSite || fetchSite === 'same-origin' || fetchSite === 'none';
}

async function safeJson(req: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (Number.isFinite(contentLength) && contentLength > 64 * 1024) return null;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf-8') > 64 * 1024) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}
