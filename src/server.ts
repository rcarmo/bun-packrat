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
  countCaptures, getCaptureDeleteImpact, deleteCapture,
} from './db/index.js';
import { JobQueue } from './queue/index.js';
import { exportHtml, slugify } from './export/html.js';
import { exportMarkdownZip, renderRemoteMarkdown } from './export/markdown.js';
import { renderMarkdownHtml } from './export/render-markdown.js';
import { resolveCaptureIndexPage } from './index-page.js';
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
        return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, id), aliases: getCaptureAliases(db, id), deleteImpact: getCaptureDeleteImpact(db, id) });
      }
      return serveCaptureHtml(db, id, url.searchParams.has('raw'));
    }

    const markdownMatch = path.match(/^\/captures\/(\d+)\/markdown(\.raw)?$/);
    if (method === 'GET' && markdownMatch) {
      const id = parseInt(markdownMatch[1], 10);
      const rendered = await renderRemoteMarkdown(db, id);
      if (!rendered) return json404('Capture not found or not yet succeeded');
      if (markdownMatch[2]) {
        return new Response(rendered.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
      }
      return renderMarkdownView(id, rendered.title, rendered.markdown, url.searchParams.get('remote') === '1');
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
        const total = countCaptures(db, q.trim() || null, filters);
        return Response.json({
          captures: rows.map(summariseCapture), limit, offset, total,
          previousOffset: offset > 0 ? Math.max(0, offset - limit) : null,
          nextOffset: offset + rows.length < total ? offset + limit : null,
        });
      } catch (err: any) {
        return Response.json({ error: `Invalid search query: ${err?.message ?? err}` }, { status: 400 });
      }
    }

    // ── API: get single capture metadata ──────────────────────────────────
    const apiCapMatch = path.match(/^\/api\/captures\/(\d+)$/);
    if (apiCapMatch) {
      const id = parseInt(apiCapMatch[1], 10);
      if (method === 'GET') {
        const c = getCaptureById(db, id);
        if (!c) return json404();
        return Response.json({ ...summariseCapture(c), tags: getCaptureTags(db, c.id), aliases: getCaptureAliases(db, c.id), deleteImpact: getCaptureDeleteImpact(db, id) });
      }
      if (method === 'DELETE') {
        const body = await safeJson(req);
        if (body?.confirm !== true && body?.confirm !== String(id)) {
          return Response.json({ error: 'Explicit deletion confirmation is required', impact: getCaptureDeleteImpact(db, id) }, { status: 409 });
        }
        const result = deleteCapture(db, id);
        return result ? Response.json({ ok: true, ...result }) : json404('Capture not found');
      }
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

async function serveCaptureHtml(db: Database, id: number, raw: boolean): Promise<Response> {
  const row = getCaptureHtml(db, id);
  if (!row?.html) return new Response('Capture not found', { status: 404 });

  let html: Buffer;
  if (row.compression === 'gzip') {
    html = Buffer.from(Bun.gunzipSync(Buffer.from(row.html)));
  } else {
    html = Buffer.from(row.html as unknown as Uint8Array);
  }

  if (!raw) {
    const toolbar = `<nav class="packrat-view-switch" style="position:sticky;top:0;z-index:2147483647;padding:.45rem 1rem;background:#222;color:#fff;font:14px system-ui,sans-serif"><strong>Archived HTML</strong> · <a style="color:#9cf" href="/captures/${id}/markdown">Markdown</a> · <a style="color:#9cf" href="/captures/${id}?raw=1">Raw archive</a></nav>`;
    html = Buffer.from(html.toString('utf-8').replace(/<body([^>]*)>/i, `<body$1>${toolbar}`));
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
  const limit  = parseBoundedInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = parseBoundedInt(url.searchParams.get('offset'), 0, 0, 1_000_000);

  const filters = captureQueryOptions(url, limit, offset);
  const page = resolveCaptureIndexPage(db, q, filters);
  if (!page.error && page.effectiveOffset !== offset) {
    const target = new URL(url);
    if (page.effectiveOffset) target.searchParams.set('offset', String(page.effectiveOffset));
    else target.searchParams.delete('offset');
    return Response.redirect(target, 302);
  }
  const { rows, matchingCount, error: searchError } = page;

  const totalCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status='succeeded'`)
    .get()?.n ?? 0;
  const failedCount = db
    .query<{ n: number }, []>(`SELECT COUNT(*) as n FROM captures WHERE status='failed'`)
    .get()?.n ?? 0;

  const tags = listTags(db).slice(0, 20);
  const filterHref = (key: string, value: string) => {
    const params = new URLSearchParams(url.searchParams);
    params.delete('offset'); params.delete('archive');
    if (value) params.set(key, value); else params.delete(key);
    return `/?${params.toString()}`;
  };

  const tagCloud = tags.length
    ? `<div class="tag-cloud">${tags.map((t) =>
        `<a class="tag${tag === t.name ? ' active' : ''}" href="${filterHref('tag', t.name)}">${esc(t.name)} <span>${t.count}</span></a>`
      ).join('')}</div>`
    : '';

  const items = rows.map((c) => `
    <li class="item">
      <div class="item-title"><a href="/captures/${c.id}">${esc(c.title ?? '(no title)')}</a> <a class="view-link" href="/captures/${c.id}/markdown">Markdown</a></div>
      <div class="item-meta">
        <a class="domain" href="${filterHref('domain', getDomain(c.source_url))}">${esc(getDomain(c.source_url))}</a>
        <span class="mode">${esc(c.mode)}</span>
        <span class="date">${esc(c.captured_at?.slice(0, 10) ?? '')}</span>
        ${c.warnings ? '<span class="warnings" title="Capture has warnings">⚠</span>' : ''}
        <a class="source-link" href="${esc(c.source_url)}" rel="noopener" target="_blank">↗</a>
        <a class="export-link" href="/captures/${c.id}/export/html" title="Download HTML">⬇ HTML</a>
        <a class="export-link" href="/captures/${c.id}/export/md"   title="Download Markdown ZIP">MD</a>
        <a class="export-link" href="/captures/${c.id}/export/epub" title="Download EPUB">EPUB</a>
        <a class="export-link" href="/captures/${c.id}/export/pdf"  title="Download PDF">PDF</a>
        <button class="recapture" data-id="${c.id}" type="button" title="Capture again now">↻</button>
        <button class="delete" data-id="${c.id}" data-title="${esc(c.title ?? '(no title)')}" data-source="${esc(c.source_url)}" data-time="${esc(c.captured_at)}" data-impact="${esc(JSON.stringify(getCaptureDeleteImpact(db, c.id)))}" type="button" title="Delete capture">Delete</button>
      </div>
      ${c.warnings ? `<details class="capture-warnings"><summary>Capture warnings</summary><ul>${parseWarnings(c.warnings).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${c.error ? `<div class="capture-error">${esc(c.error)}</div>` : ''}
      ${c.excerpt ? `<div class="item-excerpt">${esc(c.excerpt.slice(0, 200))}</div>` : ''}
    </li>`).join('');

  const queryBase = new URLSearchParams(url.searchParams);
  queryBase.delete('offset');
  const pageHref = (nextOffset: number) => {
    const params = new URLSearchParams(queryBase);
    params.set('offset', String(nextOffset));
    return `/?${params.toString()}`;
  };
  const prevHref = offset > 0 ? pageHref(Math.max(0, offset - limit)) : null;
  const nextHref = offset + rows.length < matchingCount ? pageHref(offset + limit) : null;
  const pagination = (prevHref || nextHref)
    ? `<div class="pagination">${prevHref ? `<a href="${prevHref}">← Previous</a>` : ''} ${nextHref ? `<a href="${nextHref}">Next →</a>` : ''}</div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Packrat Archive</title>
<style>
:root{color-scheme:light;--bg:#fff;--surface:#f6f7f9;--fg:#171717;--muted:#5f6368;--border:#c7cbd1;--accent:#0057b7;--accent-fg:#fff;--success:#176b40;--success-fg:#fff;--danger:#a31616;--focus:#006fe6;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151617;--surface:#232527;--fg:#f1f3f4;--muted:#bdc1c6;--border:#62666b;--accent:#8fc5ff;--accent-fg:#071b2e;--success:#6fd69c;--success-fg:#092417;--danger:#ffb4ab;--focus:#9acbff}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--font);line-height:1.5}
header{border-bottom:1px solid var(--border);padding:.8rem 1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}
header h1{margin:0;font-size:1.2rem;white-space:nowrap}
form{display:flex;gap:.4rem;flex:1;min-width:200px}
input[type=search],input[type=url],input[type=date],select{padding:.4rem .6rem;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--fg);font:inherit;font-size:.95rem}input[type=search]{flex:1}input::placeholder{color:var(--muted);opacity:1}
button{-webkit-appearance:none;appearance:none;padding:.4rem .8rem;background:var(--accent);color:var(--accent-fg);-webkit-text-fill-color:currentColor;border:1px solid transparent;border-radius:4px;font:inherit;font-weight:600;cursor:pointer}button:disabled{opacity:.55;cursor:wait}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
.capture-form{border-bottom:1px solid var(--border);padding:.5rem 1rem;display:flex;gap:.4rem;flex-wrap:wrap}
.capture-form input{flex:1;min-width:200px;font-size:.9rem}
.capture-form button{background:var(--success);color:var(--success-fg);font-size:.85rem}
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
.item-title .view-link,.item-meta a.export-link{color:var(--accent);background:var(--surface)}.export-link,.view-link{font-size:.72rem;padding:.14rem .38rem;border:1px solid var(--border);border-radius:3px}.recapture,.delete{font-size:.72rem;padding:.14rem .4rem;background:var(--surface);color:var(--fg);border:1px solid var(--border)}.delete{color:var(--danger)}
.item-excerpt{font-size:.82rem;color:var(--muted);margin-top:.3rem;line-height:1.4}.capture-warnings,.capture-error{font-size:.78rem;color:#9a6700;margin-top:.3rem}.capture-warnings ul{list-style:disc;padding-left:1.2rem}.capture-error{color:#b42318}
.pagination{padding:.8rem 1rem;display:flex;gap:1rem;font-size:.9rem}
.pagination a{color:var(--accent)}
</style>
</head>
<body>
<header>
  <h1>📦 Packrat</h1>
  <form method="GET" action="/">
    <input type="search" name="q" value="${esc(q)}" placeholder="Full-text search…" autocomplete="off">
    <input type="search" name="title" value="${esc(url.searchParams.get('title') ?? '')}" placeholder="Title">
    <input type="search" name="url" value="${esc(url.searchParams.get('url') ?? '')}" placeholder="URL">
    <input type="date" name="dateFrom" value="${esc(url.searchParams.get('dateFrom') ?? '')}" aria-label="From date">
    <input type="date" name="dateTo" value="${esc(url.searchParams.get('dateTo') ?? '')}" aria-label="To date">
    <select name="status"><option value=""${!url.searchParams.get('status') ? ' selected' : ''}>Succeeded</option><option value="all"${url.searchParams.get('status') === 'all' ? ' selected' : ''}>All status</option><option value="failed"${url.searchParams.get('status') === 'failed' ? ' selected' : ''}>Failed</option></select>
    <select name="mode" aria-label="Capture mode"><option value=""${!mode ? ' selected' : ''}>All modes</option><option value="article"${mode === 'article' ? ' selected' : ''}>Article</option><option value="full_page"${mode === 'full_page' ? ' selected' : ''}>Full page</option><option value="metadata_only"${mode === 'metadata_only' ? ' selected' : ''}>Metadata only</option></select>
    <select name="sort" aria-label="Sort"><option value="relevance"${sort === 'relevance' ? ' selected' : ''}>Relevance</option><option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest</option><option value="oldest"${sort === 'oldest' ? ' selected' : ''}>Oldest</option></select>
    <select name="limit" aria-label="Page size"><option${limit === 25 ? ' selected' : ''}>25</option><option${limit === 50 ? ' selected' : ''}>50</option><option${limit === 100 ? ' selected' : ''}>100</option><option${limit === 200 ? ' selected' : ''}>200</option></select>
    <button type="submit">Search</button>
  </form>
</header>
<form class="capture-form" id="capture-form">
  <input type="url" id="capture-url" value="${esc(archive)}" placeholder="Archive a URL…" required>
  <button type="submit">Archive</button>
  <span id="capture-status" style="font-size:.82rem;color:var(--muted);padding:.3rem 0"></span>
</form>
${tagCloud}
<p class="count">${matchingCount ? `${offset + 1}–${Math.min(offset + rows.length, matchingCount)} of ` : ''}${matchingCount.toLocaleString()} matching · ${totalCount.toLocaleString()} total · <a href="${filterHref('status', 'failed')}">${failedCount} failed</a>${q ? ` for "${esc(q)}"` : ''}${domain ? ` from ${esc(domain)}` : ''}${tag ? ` tagged ${esc(tag)}` : ''}</p>
<ul>${searchError ? `<li class="capture-error" style="padding:1rem">${esc(searchError)}</li>` : items || '<li style="padding:1rem;color:var(--muted)">No captures yet.</li>'}</ul>
${pagination}
<script>
document.querySelectorAll('.delete').forEach((button) => button.addEventListener('click', async () => {
  const impact = JSON.parse(button.dataset.impact || '{}');
  const message = 'Permanently delete capture #' + button.dataset.id + '?\n\n' + button.dataset.title + '\n' + button.dataset.source + '\n' + button.dataset.time + '\n\nAffected relations: ' + (impact.aliases||0) + ' aliases, ' + (impact.metadata||0) + ' metadata rows, ' + (impact.tags||0) + ' tags. ' + (impact.jobs||0) + ' job records will be retained.';
  if (!confirm(message)) return;
  button.disabled = true;
  const r = await fetch('/api/captures/' + button.dataset.id, {method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:button.dataset.id})});
  if (r.ok) {
    const params = new URLSearchParams(location.search);
    const currentOffset = Number(params.get('offset') || 0);
    if (document.querySelectorAll('.item').length === 1 && currentOffset > 0) params.set('offset', String(Math.max(0, currentOffset - Number(params.get('limit') || 50))));
    location.search = params.toString();
  } else { button.disabled=false; alert('Deletion failed'); }
}));
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
  const sort = sortRaw === 'oldest' || sortRaw === 'relevance' || sortRaw === 'newest'
    ? sortRaw : undefined;
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

function renderMarkdownView(id: number, title: string, markdown: string, remoteImages: boolean): Response {
  const content = renderMarkdownHtml(markdown, remoteImages);
  const enableHref = `/captures/${id}/markdown?remote=1`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Markdown</title><style>:root{color-scheme:light;--bg:#fff;--surface:#f4f5f7;--fg:#202124;--muted:#5f6368;--border:#c7cbd1;--accent:#0057b7;--notice-bg:#fff4ce;--notice-fg:#4f3b00;--notice-border:#b88a00}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151617;--surface:#252729;--fg:#f1f3f4;--muted:#bdc1c6;--border:#62666b;--accent:#8fc5ff;--notice-bg:#403711;--notice-fg:#fff2b2;--notice-border:#ad8b16}}*{box-sizing:border-box}body{max-width:760px;margin:auto;padding:1rem;background:var(--bg);color:var(--fg);font:17px/1.6 Georgia,serif}a{color:var(--accent)}nav,.warning{font:14px system-ui,sans-serif}.warning{padding:.8rem;background:var(--notice-bg);color:var(--notice-fg);border:1px solid var(--notice-border);border-radius:4px}.warning a{color:inherit;font-weight:700}img{max-width:100%;height:auto}pre{overflow:auto;background:var(--surface);border:1px solid var(--border);padding:1rem}code{background:var(--surface)}.image-placeholder{display:block;padding:1rem;background:var(--surface);color:var(--muted);border:1px solid var(--border)}</style></head><body><nav><a href="/captures/${id}">Archived HTML</a> · <strong>Markdown</strong> · <a href="/captures/${id}/markdown.raw">Raw Markdown</a></nav>${remoteImages ? '<p class="warning">Remote images are enabled. This view contacts the original image hosts.</p>' : `<p class="warning">Remote images are disabled. Enabling them contacts the original hosts and may disclose your IP address and browser headers. <a href="${enableHref}">Enable for this view</a></p>`}<main>${content}</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': remoteImages ? "default-src 'none'; style-src 'unsafe-inline'; img-src https: http:; base-uri 'none'; frame-ancestors 'none'" : "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }});
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
