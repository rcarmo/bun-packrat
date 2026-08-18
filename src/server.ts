/**
 * bun-packrat — HTTP server
 * Phase 2: job queue, export routes (HTML/MD/EPUB/PDF), detail page, search UI.
 */

import type { Database } from 'bun:sqlite';
import type { PackratConfig, CaptureMetadataRow } from './types.js';
import {
  openDatabase, runMigrations,
  getCaptureHtml, getCaptureById, getSourcePdfMetadata, getSourcePdfRange, getSourcePdfText, listCaptures, searchCaptures,
  getCaptureTags, addTagToCapture, removeTagFromCapture, listTags, getJobById, getJobAttempts,
  createJob, getCaptureAliases, updateCaptureNote, cancelJob,
  countCaptures, getCaptureDeleteImpact, deleteCapture,
} from './db/index.js';
import { JobQueue } from './queue/index.js';
import { exportHtml, slugify } from './export/html.js';
import { exportMarkdownZip, renderRemoteMarkdown, type MarkdownAsset } from './export/markdown.js';
import { renderMarkdownHtml } from './export/render-markdown.js';
import { resolveCaptureIndexPage } from './index-page.js';
import { deriveStoredArticleHtml, detectStoredCaptureFormat, readStoredCaptureBytes, renderStoredCaptureHtml } from './capture/canonical.js';
import { INDEX_CLIENT_SCRIPT } from './index-client.js';
import { exportEpub } from './export/epub.js';
import { exportPdf } from './export/pdf.js';
import { loadConfig } from './config.js';
import { parseSingleByteRange } from './http/range.js';

const config = loadConfig();
if (!config.authDisabled && !config.authPassword) {
  throw new Error('Set PACKRAT_AUTH_PASSWORD or explicitly set PACKRAT_AUTH_DISABLED=1');
}
const db = openDatabase(config.dbPath);
runMigrations(db);

const markdownAssetCache = new Map<number, { assets: MarkdownAsset[]; bytes: number; touchedAt: number }>();
const MAX_MARKDOWN_ASSET_CACHE_BYTES = 32 * 1024 * 1024;

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
      if (url.searchParams.has('raw')) return serveCaptureHtml(db, id, true);
      const acceptsHtml = (req.headers.get('accept') ?? '').includes('text/html');
      const capture = getCaptureById(db, id);
      if (!capture) return json404();
      // JSON API
      if (!acceptsHtml || url.searchParams.has('meta')) {
        return Response.json({ ...summariseCapture(capture), tags: getCaptureTags(db, id), aliases: getCaptureAliases(db, id), deleteImpact: getCaptureDeleteImpact(db, id) });
      }
      if (capture.mode === 'pdf') return renderPdfCapture(db, capture);
      if (capture.mode === 'metadata_only') return renderMetadataOnlyCapture(db, capture);
      return serveCaptureHtml(db, id, false);
    }

    const articleMatch = path.match(/^\/captures\/(\d+)\/article$/);
    if (method === 'GET' && articleMatch) {
      return serveArticleHtml(db, parseInt(articleMatch[1], 10));
    }

    const markdownImageMatch = path.match(/^\/captures\/(\d+)\/images\/(\d+)$/);
    if ((method === 'GET' || method === 'HEAD') && markdownImageMatch) {
      return serveMarkdownImage(db, parseInt(markdownImageMatch[1], 10), parseInt(markdownImageMatch[2], 10), method === 'HEAD');
    }

    const markdownMatch = path.match(/^\/captures\/(\d+)\/markdown(\.raw)?$/);
    if (method === 'GET' && markdownMatch) {
      const id = parseInt(markdownMatch[1], 10);
      const rendered = await renderRemoteMarkdown(db, id, { archivedImageBase:`/captures/${id}/images` });
      if (!rendered) return json404('Capture not found or not yet succeeded');
      rememberMarkdownAssets(id, rendered.assets);
      if (markdownMatch[2]) {
        return new Response(rendered.markdown, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" } });
      }
      const sourceHref = safeExternalHref(getCaptureById(db, id)?.source_url ?? '');
      return renderMarkdownView(id, rendered.title, rendered.markdown, rendered.assets.length, rendered.remoteImageCount, url.searchParams.get('remote') === '1', sourceHref);
    }

    const sourcePdfMatch = path.match(/^\/captures\/(\d+)\/source\.pdf$/);
    if ((method === 'GET' || method === 'HEAD') && sourcePdfMatch) {
      return serveSourcePdf(db, parseInt(sourcePdfMatch[1], 10), req, url.searchParams.has('download'));
    }

    const sourcePdfTextMatch = path.match(/^\/captures\/(\d+)\/source\.txt$/);
    if ((method === 'GET' || method === 'HEAD') && sourcePdfTextMatch) {
      return serveSourcePdfText(db, parseInt(sourcePdfTextMatch[1], 10), method === 'HEAD');
    }

    const contentMatch = path.match(/^\/api\/captures\/(\d+)\/content\/(mhtml|html|article-html|markdown|markdown-zip|epub|pdf|source-pdf|source-pdf-text)$/);
    if ((method === 'GET' || method === 'HEAD') && contentMatch) {
      if (contentMatch[2] === 'source-pdf') return serveSourcePdf(db, parseInt(contentMatch[1], 10), req, false);
      if (contentMatch[2] === 'source-pdf-text') return serveSourcePdfText(db, parseInt(contentMatch[1], 10), method === 'HEAD');
      if (method === 'HEAD') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
      return handleApiContent(db, parseInt(contentMatch[1], 10), contentMatch[2], config);
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
        if (!getCaptureById(db, id)) return json404('Capture not found');
        return Response.json({ tags: getCaptureTags(db, id) });
      }
      if (method === 'POST' || method === 'DELETE') {
        if (!getCaptureById(db, id)) return json404('Capture not found');
        const body = await safeJson(req);
        const tagValue = body?.tag;
        const tag = typeof tagValue === 'string' ? tagValue.trim() : '';
        if (!tag) return Response.json({ error: '"tag" is required' }, { status: 400 });
        try {
          if (method === 'POST') addTagToCapture(db, id, tag);
          else removeTagFromCapture(db, id, tag);
        } catch (err: any) {
          return Response.json({ error: err?.message ?? 'Invalid tag' }, { status: 400 });
        }
        return Response.json({ ok: true, tags: getCaptureTags(db, id) });
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
          captures: rows.map(summariseCaptureForApi), limit, offset, total,
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
        return Response.json({ ...summariseCaptureForApi(c), tags: getCaptureTags(db, c.id), aliases: getCaptureAliases(db, c.id), deleteImpact: getCaptureDeleteImpact(db, id) });
      }
      if (method === 'DELETE') {
        const body = await safeJson(req);
        if (body?.confirm !== true && body?.confirm !== String(id)) {
          return Response.json({ error: 'Explicit deletion confirmation is required', impact: getCaptureDeleteImpact(db, id) }, { status: 409 });
        }
        const result = deleteCapture(db, id);
        if (result) markdownAssetCache.delete(id);
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
    if (method === 'GET' && path === '/status') {
      return renderStatusPage(db, queue);
    }
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

async function handleApiContent(
  db: Database,
  id: number,
  format: string,
  config: PackratConfig,
): Promise<Response> {
  const meta = getCaptureById(db, id);
  if (!meta || meta.status !== 'succeeded') return json404('Capture not found or not yet succeeded');
  const headers = contentProvenanceHeaders(meta, format);

  if (format === 'mhtml') {
    const row = getCaptureHtml(db, id);
    if (!row?.html) return json404('Capture body not found');
    const bytes = readStoredCaptureBytes(row);
    if (detectStoredCaptureFormat(bytes) !== 'mhtml') {
      return Response.json({ error: 'Canonical MHTML is unavailable for this legacy capture' }, { status: 409, headers });
    }
    return new Response(new Blob([Uint8Array.from(bytes).buffer]), { headers: {
      ...headers,
      'Content-Type': 'multipart/related',
      'Content-Disposition': `attachment; filename="${slugify(meta.title ?? `capture-${id}`)}.mhtml"`,
    }});
  }

  if (format === 'article-html') {
    const row = getCaptureHtml(db, id);
    if (!row?.html) return json404('Capture body not found');
    const html = renderArticleDocument(deriveStoredArticleHtml(row, meta.final_url));
    return new Response(html, { headers: {
      ...headers,
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${slugify(meta.title ?? `capture-${id}`)}-article.html"`,
      'Content-Security-Policy': csp(),
    }});
  }

  if (format === 'markdown') {
    const rendered = await renderRemoteMarkdown(db, id);
    if (!rendered) return json404('Capture not found or not yet succeeded');
    return new Response(rendered.markdown, { headers: {
      ...headers,
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'",
    }});
  }

  const legacyFormat = format === 'markdown-zip' ? 'md' : format;
  const response = await handleExport(db, id, legacyFormat, config);
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

function contentProvenanceHeaders(capture: CaptureMetadataRow, format: string): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Packrat-Capture-Id': String(capture.id),
    'X-Packrat-Content-Format': format,
    'X-Packrat-Content-Hash': capture.content_hash ?? '',
    'X-Packrat-Source-Url': encodeURI(capture.source_url),
    'X-Packrat-Final-Url': encodeURI(capture.final_url),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Source PDF delivery
// ────────────────────────────────────────────────────────────────────────────

function serveSourcePdf(db: Database, id: number, req: Request, download: boolean): Response {
  const pdf = getSourcePdfMetadata(db, id);
  const capture = getCaptureById(db, id);
  if (!pdf || !capture) return json404('Source PDF not found');
  const baseHeaders: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${sourcePdfFilename(pdf.source_filename, id)}"`,
    'ETag': `"sha256-${pdf.sha256}"`,
    'X-Content-Type-Options': 'nosniff',
    'X-Packrat-Capture-Id': String(id),
    'X-Packrat-Content-Format': 'source-pdf',
    'X-Packrat-Content-Hash': pdf.sha256,
    'X-Packrat-Source-Url': encodeURI(capture.source_url),
    'X-Packrat-Final-Url': encodeURI(capture.final_url),
  };
  const range = req.headers.get('range');
  if (!range) {
    baseHeaders['Content-Length'] = String(pdf.byte_size);
    if (req.method === 'HEAD') return new Response(null, { headers: baseHeaders });
    return new Response(streamSourcePdf(db, id, pdf.byte_size), { headers: baseHeaders });
  }
  const parsed = parseSingleByteRange(range, pdf.byte_size);
  if (!parsed) return new Response(null, { status: 416, headers: { ...baseHeaders, 'Content-Range': `bytes */${pdf.byte_size}` } });
  const [start, end] = parsed;
  baseHeaders['Content-Length'] = String(end - start + 1);
  baseHeaders['Content-Range'] = `bytes ${start}-${end}/${pdf.byte_size}`;
  if (req.method === 'HEAD') return new Response(null, { status: 206, headers: baseHeaders });
  const bytes = getSourcePdfRange(db, id, start, end);
  return bytes ? new Response(new Blob([Uint8Array.from(bytes).buffer]), { status: 206, headers: baseHeaders }) : json404('Source PDF not found');
}

function streamSourcePdf(db: Database, id: number, byteSize: number): ReadableStream<Uint8Array> {
  const chunkSize = 1024 * 1024;
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= byteSize) { controller.close(); return; }
      const end = Math.min(byteSize - 1, offset + chunkSize - 1);
      const bytes = getSourcePdfRange(db, id, offset, end);
      if (!bytes) { controller.error(new Error('Source PDF disappeared during delivery')); return; }
      offset = end + 1;
      controller.enqueue(bytes);
    },
  });
}

function serveSourcePdfText(db: Database, id: number, head: boolean): Response {
  const text = getSourcePdfText(db, id);
  if (!text) return json404('Source PDF not found');
  if (!['succeeded', 'image_only'].includes(text.status)) {
    return Response.json({ error: 'Extracted PDF text is unavailable', extractionStatus: text.status }, { status: 409 });
  }
  const headers = {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Disposition': `attachment; filename="capture-${id}.txt"`,
    'Content-Length': String(Buffer.byteLength(text.text ?? '', 'utf8')),
    'X-Content-Type-Options': 'nosniff',
    'X-Packrat-Capture-Id': String(id),
  };
  return new Response(head ? null : text.text ?? '', { headers });
}

function sourcePdfFilename(value: string | null, id: number): string {
  const name = value?.replace(/[^a-zA-Z0-9._ -]/g, '_').trim();
  const withExtension = name && name.toLowerCase().endsWith('.pdf') ? name : name ? `${name}.pdf` : `capture-${id}.pdf`;
  return withExtension.slice(0, 200);
}

// ────────────────────────────────────────────────────────────────────────────
// HTML rendering
// ────────────────────────────────────────────────────────────────────────────

async function serveCaptureHtml(db: Database, id: number, raw: boolean): Promise<Response> {
  const row = getCaptureHtml(db, id);
  const meta = getCaptureById(db, id);
  if (!row?.html || !meta) return new Response('Capture not found', { status: 404 });

  const storedBytes = readStoredCaptureBytes(row);
  if (raw) {
    const format = detectStoredCaptureFormat(storedBytes);
    return new Response(new Blob([Uint8Array.from(storedBytes).buffer]), { headers: {
      'Content-Type': format === 'mhtml' ? 'multipart/related' : 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="capture-${id}.${format === 'mhtml' ? 'mhtml' : 'html'}"`,
      'X-Content-Type-Options': 'nosniff',
    }});
  }

  let html = renderStoredCaptureHtml(row);
  if (!raw) {
    const sourceLink = renderOriginalLink(meta.source_url, 'color:#9cf');
    const toolbar = `<nav class="packrat-view-switch" style="position:sticky;top:0;z-index:2147483647;padding:.45rem 1rem;background:#222;color:#fff;font:14px system-ui,sans-serif"><strong>Full page</strong> · <a style="color:#9cf" href="/captures/${id}/article">Article</a> · <a style="color:#9cf" href="/captures/${id}/markdown">Markdown</a> · <a style="color:#9cf" href="/captures/${id}?raw=1">Canonical MHTML</a>${sourceLink ? ` · ${sourceLink}` : ''}</nav>`;
    html = html.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`);
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

function renderPdfCapture(db: Database, capture: CaptureMetadataRow): Response {
  const pdf = getSourcePdfMetadata(db, capture.id);
  if (!pdf) return json404('Source PDF not found');
  const sourceHref = safeExternalHref(capture.source_url);
  const textAction = pdf.extraction_status === 'succeeded' || pdf.extraction_status === 'image_only'
    ? `<a href="/captures/${capture.id}/source.txt">Download extracted text</a>`
    : `<span>Text extraction: ${esc(pdf.extraction_status.replace('_', ' '))}</span>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(capture.title ?? 'PDF capture')}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif}nav{display:flex;flex-wrap:wrap;gap:1rem;padding:.75rem 1rem;background:#222;color:#fff}nav a{color:#9cf}iframe{display:block;width:100%;height:calc(100vh - 3rem);border:0}.status{padding:1rem}</style></head><body><nav><a href="/">Archive</a><strong>${esc(capture.title ?? 'PDF')}</strong><a href="/captures/${capture.id}/source.pdf?download=1">Download PDF</a>${textAction}${sourceHref ? `<a href="${esc(sourceHref)}" rel="noopener noreferrer">Original source</a>` : ''}</nav><iframe title="${esc(capture.title ?? 'Archived PDF')}" src="/captures/${capture.id}/source.pdf"></iframe></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }});
}

function renderMetadataOnlyCapture(db: Database, capture: CaptureMetadataRow): Response {
  const sourceHref = safeExternalHref(capture.source_url);
  const warnings = parseWarnings(capture.warnings);
  const tags = getCaptureTags(db, capture.id);
  const provenance = db.query<{ ab_id: string; ab_timestamp: string | null; ab_status: string | null; outcome: string | null; outcome_detail: string | null }, [number]>(
    'SELECT ab_id,ab_timestamp,ab_status,outcome,outcome_detail FROM archivebox_imports WHERE capture_id=? ORDER BY id LIMIT 1',
  ).get(capture.id);
  const rows: Array<[string, string]> = [
    ['Source URL', capture.source_url],
    ['Captured', capture.captured_at],
    ['Status', capture.status],
    ['Storage mode', 'Metadata only'],
  ];
  if (provenance?.ab_id) rows.push(['ArchiveBox snapshot ID', provenance.ab_id]);
  if (provenance?.ab_timestamp) rows.push(['ArchiveBox timestamp', provenance.ab_timestamp]);
  if (provenance?.outcome) rows.push(['Migration outcome', provenance.outcome]);
  if (provenance?.outcome_detail) rows.push(['Migration detail', provenance.outcome_detail]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(capture.title ?? 'Metadata-only capture')}</title><style>:root{color-scheme:light dark}*{box-sizing:border-box}body{max-width:820px;margin:0 auto;padding:1rem 1rem 3rem;font:16px/1.55 system-ui,sans-serif;overflow-wrap:anywhere}nav{display:flex;gap:1rem;align-items:center;margin:0 -1rem 2rem;padding:.7rem 1rem;background:#222;color:#fff}nav a{color:#9cf}h1{line-height:1.2}table{width:100%;border-collapse:collapse}th,td{padding:.65rem;border:1px solid #888;text-align:left;vertical-align:top}th{width:12rem}code{overflow-wrap:anywhere}aside{margin:1.5rem 0;padding:1rem;border:1px solid #b88700;border-radius:.4rem;background:color-mix(in srgb,#b88700 12%,transparent)}.tags{display:flex;flex-wrap:wrap;gap:.5rem}.tag{padding:.15rem .55rem;border:1px solid #888;border-radius:2rem}@media(max-width:520px){th,td{display:block;width:100%}th{border-bottom:0}}</style></head><body><nav><a href="/">Archive</a>${sourceHref ? `<a href="${esc(sourceHref)}" rel="noopener noreferrer">Original source</a>` : ''}</nav><main><h1>${esc(capture.title ?? '(no title)')}</h1><aside><strong>No archived page body is available.</strong> This source row is retained for search, provenance and reconciliation and does not offer Full page, Article, Markdown or export views.</aside><table><tbody>${rows.map(([name,value]) => `<tr><th>${esc(name)}</th><td>${name === 'Source URL' && sourceHref ? `<a href="${esc(sourceHref)}" rel="noopener noreferrer">${esc(value)}</a>` : `<code>${esc(value)}</code>`}</td></tr>`).join('')}</tbody></table>${tags.length ? `<h2>Tags</h2><div class="tags">${tags.map((tag) => `<span class="tag">${esc(tag)}</span>`).join('')}</div>` : ''}${warnings.length ? `<h2>Warnings</h2><ul>${warnings.map((warning) => `<li>${esc(warning)}</li>`).join('')}</ul>` : ''}</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp(),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }});
}

async function serveArticleHtml(db: Database, id: number): Promise<Response> {
  const meta = getCaptureById(db, id);
  const row = getCaptureHtml(db, id);
  if (!meta || meta.status !== 'succeeded' || !row?.html) return json404('Capture not found or not yet succeeded');
  const article = renderArticleDocument(deriveStoredArticleHtml(row, meta.final_url));
  const sourceLink = renderOriginalLink(meta.source_url);
  const toolbar = `<nav class="packrat-article-switch"><a href="/captures/${id}">Full page</a><strong>Article</strong><a href="/captures/${id}/markdown">Markdown</a><a href="/captures/${id}?raw=1">Canonical MHTML</a>${sourceLink}</nav>`;
  return new Response(article.replace(/<body([^>]*)>/i, `<body$1>${toolbar}`), { headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': csp(),
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  }});
}

function renderArticleDocument(html: string): string {
  const articleCss = `<style id="packrat-article-style">:root{color-scheme:light;--bg:#fff;--fg:#202124;--muted:#5f6368;--surface:#f4f5f7;--border:#c7cbd1;--accent:#0057b7}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151617;--fg:#f1f3f4;--muted:#bdc1c6;--surface:#252729;--border:#62666b;--accent:#8fc5ff}}*{box-sizing:border-box}html{background:var(--bg);color:var(--fg)}body{max-width:780px;margin:auto;padding:0 1rem 3rem;background:var(--bg);color:var(--fg);font:18px/1.65 Georgia,serif;overflow-wrap:anywhere}.packrat-article-switch{position:sticky;top:0;z-index:10;display:flex;gap:.85rem;align-items:center;margin:0 -1rem 1.5rem;padding:.65rem 1rem;background:#222;color:#fff;font:14px/1.4 system-ui,sans-serif}.packrat-article-switch a{color:#9cf}.packrat-content{min-width:0}h1,h2,h3,h4{line-height:1.2;margin-top:1.5em}a{color:var(--accent)}img{display:block;max-width:100%;height:auto;margin:1.5rem auto}figure{max-width:100%;margin:1.5rem 0}figcaption{color:var(--muted);font:14px/1.45 system-ui,sans-serif;text-align:center}pre{max-width:100%;padding:1rem;overflow:auto;background:var(--surface);border:1px solid var(--border);border-radius:5px;font:14px/1.45 ui-monospace,monospace}:not(pre)>code{padding:.1em .25em;background:var(--surface);overflow-wrap:anywhere;word-break:break-word}blockquote{margin-left:0;padding-left:1rem;border-left:3px solid var(--border)}table{display:block;max-width:100%;overflow-x:auto;border-collapse:collapse;font:14px/1.45 system-ui,sans-serif}th,td{padding:.5rem .65rem;border:1px solid var(--border);text-align:left;vertical-align:top}@media(max-width:480px){body{font-size:17px}.packrat-article-switch{gap:.65rem;overflow-x:auto;white-space:nowrap}}</style>`;
  return html.includes('</head>') ? html.replace(/<\/head>/i, `${articleCss}</head>`) : html.replace(/<body/i, `<head>${articleCss}</head><body`);
}

async function renderIndex(db: Database, url: URL): Promise<Response> {
  const archive = url.searchParams.get('archive') ?? '';
  const q      = url.searchParams.get('q') ?? '';
  const domain = url.searchParams.get('domain') ?? '';
  const tag    = url.searchParams.get('tag') ?? '';
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

  const activeFilterDefinitions: Array<[string, string, string]> = [
    ['q', 'Search', q],
    ['title', 'Title', url.searchParams.get('title') ?? ''],
    ['url', 'URL', url.searchParams.get('url') ?? ''],
    ['domain', 'Domain', domain],
    ['tag', 'Tag', tag],
    ['dateFrom', 'From', url.searchParams.get('dateFrom') ?? ''],
    ['dateTo', 'To', url.searchParams.get('dateTo') ?? ''],
    ['status', 'Status', url.searchParams.get('status') ?? ''],
    ['sort', 'Sort', url.searchParams.has('sort') ? sort : ''],
  ];
  const activeFilters = activeFilterDefinitions.filter(([, , value]) => value);
  const activeFilterBar = activeFilters.length
    ? `<div class="active-filters" aria-label="Active filters"><span class="active-filters-label">Active</span>${activeFilters.map(([key, label, value]) =>
        `<a class="filter-chip" href="${esc(filterHref(key, ''))}" aria-label="Clear ${esc(label)} filter"><span>${esc(label)}: ${esc(value)}</span><b aria-hidden="true">×</b></a>`
      ).join('')}<a class="clear-filters" href="/">Clear all</a></div>`
    : '';

  const tagCloud = tags.length
    ? `<div class="tag-cloud">${tags.map((t) =>
        `<a class="tag${tag === t.name ? ' active' : ''}" href="${esc(filterHref('tag', tag === t.name ? '' : t.name))}"${tag === t.name ? ' aria-label="Clear selected tag filter"' : ''}>${esc(t.name)} <span>${t.count}</span></a>`
      ).join('')}</div>`
    : '';

  const items = rows.map((c) => {
    const sourceHref = safeExternalHref(c.source_url);
    const captureTags = getCaptureTags(db, c.id);
    const metadataOnly = c.mode === 'metadata_only';
    const sourcePdf = c.mode === 'pdf';
    const primaryHref = metadataOnly || sourcePdf ? `/captures/${c.id}` : `/captures/${c.id}/article`;
    const viewActions = metadataOnly
      ? `<a href="/captures/${c.id}">Metadata and provenance</a>`
      : sourcePdf
        ? `<a href="/captures/${c.id}">View PDF</a>${c.source_pdf_extraction_status === 'succeeded' || c.source_pdf_extraction_status === 'image_only' ? `<a href="/captures/${c.id}/source.txt">Extracted text</a>` : ''}`
        : `<a href="/captures/${c.id}">Full page</a><a href="/captures/${c.id}/markdown">Markdown</a>`;
    const downloadActions = metadataOnly ? '' : sourcePdf
      ? `<div class="item-menu-group"><span class="item-menu-label">Download</span><a class="download-link" href="/captures/${c.id}/source.pdf?download=1"><span aria-hidden="true">↓</span> Source PDF</a>${c.source_pdf_extraction_status === 'succeeded' || c.source_pdf_extraction_status === 'image_only' ? `<a class="download-link" href="/captures/${c.id}/source.txt"><span aria-hidden="true">↓</span> Extracted text</a>` : ''}</div>`
      : `<div class="item-menu-group"><span class="item-menu-label">Download</span><a class="download-link" href="/captures/${c.id}/export/html"><span aria-hidden="true">↓</span> HTML</a><a class="download-link" href="/captures/${c.id}/export/md"><span aria-hidden="true">↓</span> Markdown ZIP</a><a class="download-link" href="/captures/${c.id}/export/epub"><span aria-hidden="true">↓</span> EPUB</a><a class="download-link" href="/captures/${c.id}/export/pdf"><span aria-hidden="true">↓</span> PDF</a></div>`;
    const exceptionalMode = sourcePdf ? 'Source PDF' : metadataOnly ? 'Metadata only' : c.mode === 'imported_singlefile' ? 'Imported page' : c.mode === 'article' ? 'Legacy article' : null;
    const attribution = captureAttribution(c.author, c.site_name, getDomain(c.source_url));
    return `
    <li class="item">
      <div class="item-heading">
        <div class="item-title"><a href="${primaryHref}">${esc(c.title ?? '(no title)')}</a></div>
        <details class="item-more">
          <summary>More</summary>
          <div class="item-menu" aria-label="More actions for ${esc(c.title ?? 'capture')}">
            <div class="item-menu-group">
              <span class="item-menu-label">View</span>
              ${viewActions}
            </div>
            ${downloadActions}
            <div class="item-menu-group item-menu-manage">
              <span class="item-menu-label">Manage</span>
              <button class="manage-tags" data-id="${c.id}" type="button" aria-expanded="false" aria-controls="tag-editor-${c.id}">Manage tags…</button>
              <div class="tag-editor" id="tag-editor-${c.id}" data-id="${c.id}" hidden></div>
              <button class="recapture" data-id="${c.id}" type="button">Recapture</button>
              <button class="delete" data-id="${c.id}" data-title="${esc(c.title ?? '(no title)')}" data-source="${esc(c.source_url)}" data-time="${esc(c.captured_at)}" data-impact="${esc(JSON.stringify(getCaptureDeleteImpact(db, c.id)))}" type="button">Delete…</button>
            </div>
          </div>
        </details>
      </div>
      <div class="item-facts">
        <a class="domain" href="${filterHref('domain', getDomain(c.source_url))}">${esc(getDomain(c.source_url))}</a>
        <span aria-hidden="true">·</span>
        <span>${esc(c.captured_at?.slice(0, 10) ?? '')}</span>
        ${c.html_size != null ? `<span aria-hidden="true">·</span><span class="capture-size" title="Canonical capture size">${formatBytes(c.html_size)}</span>` : ''}
        ${exceptionalMode ? `<span aria-hidden="true">·</span><span>${exceptionalMode}</span>` : ''}
        ${attribution ? `<span aria-hidden="true">·</span><span>${esc(attribution)}</span>` : ''}
        ${sourceHref ? `<span aria-hidden="true">·</span><a class="original-link" href="${esc(sourceHref)}" rel="noopener noreferrer" target="_blank">Original <span aria-hidden="true">↗</span></a>` : ''}
        ${c.warnings ? '<span class="warnings" title="Capture has warnings" aria-label="Capture has warnings">⚠</span>' : ''}
      </div>
      ${captureTags.length ? `<div class="item-tags" aria-label="Tags">${captureTags.map((itemTag) => `<a class="tag${tag === itemTag ? ' active' : ''}" href="${esc(filterHref('tag', tag === itemTag ? '' : itemTag))}"${tag === itemTag ? ' aria-label="Clear selected tag filter"' : ''}>${esc(itemTag)}</a>`).join('')}</div>` : ''}
      ${c.warnings ? `<details class="capture-warnings"><summary>Capture warnings</summary><ul>${parseWarnings(c.warnings).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></details>` : ''}
      ${c.error ? `<div class="capture-error">${esc(c.error)}</div>` : ''}
    </li>`;
  }).join('');

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
:root{color-scheme:light;--canvas:#f6f8fa;--canvas-default:#fff;--canvas-subtle:#f6f8fa;--fg:#1f2328;--fg-muted:#59636e;--border:#d1d9e0;--border-muted:#d8dee4;--accent:#0969da;--accent-emphasis:#0969da;--accent-fg:#fff;--success:#1f883d;--success-hover:#1a7f37;--danger:#d1242f;--danger-muted:#ffebe9;--header:#25292e;--header-fg:#fff;--focus:#0969da;--shadow:0 1px 0 rgba(31,35,40,.04);--font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--canvas:#0d1117;--canvas-default:#161b22;--canvas-subtle:#21262d;--fg:#f0f6fc;--fg-muted:#8b949e;--border:#30363d;--border-muted:#21262d;--accent:#58a6ff;--accent-emphasis:#1f6feb;--accent-fg:#fff;--success:#238636;--success-hover:#2ea043;--danger:#f85149;--danger-muted:#3d1214;--header:#010409;--header-fg:#f0f6fc;--focus:#58a6ff;--shadow:0 0 transparent}}
*{box-sizing:border-box}html{background:var(--canvas)}body{margin:0;background:var(--canvas);color:var(--fg);font:14px/1.5 var(--font)}a{color:var(--accent)}
.app-header{background:var(--header);color:var(--header-fg);box-shadow:0 1px 0 rgba(255,255,255,.08)}.app-header-inner{max-width:1280px;min-height:64px;margin:auto;padding:0 24px;display:flex;align-items:center;gap:12px}.brand{display:inline-flex;align-items:center;gap:8px;color:var(--header-fg);font-size:16px;font-weight:600;text-decoration:none}.brand svg{fill:currentColor}.app-context{padding-left:12px;border-left:1px solid rgba(255,255,255,.25);color:rgba(255,255,255,.75)}.status-link{margin-left:auto;color:var(--header-fg);font-weight:600;text-decoration:none}.status-link:hover{text-decoration:underline}
.page{max-width:1280px;margin:0 auto;padding:24px}.page-heading{display:flex;align-items:center;gap:10px;margin-bottom:16px}.page-heading h1{margin:0;font-size:24px;font-weight:400;line-height:1.25}.page-heading p{margin:3px 0 0;color:var(--fg-muted)}.Counter{display:inline-block;min-width:20px;padding:0 6px;border-radius:2em;background:rgba(175,184,193,.2);color:var(--fg);font-size:12px;font-weight:600;line-height:18px;text-align:center}
.Box{margin-bottom:16px;border:1px solid var(--border);border-radius:6px;background:var(--canvas-default);overflow:hidden}.Box-header{padding:12px 16px;border-bottom:1px solid var(--border);background:var(--canvas-subtle)}.Box-title{margin:0;font-size:14px;font-weight:600}.Box-body{padding:16px}
input[type=search],input[type=url],input[type=date],select{width:100%;min-width:0;height:32px;padding:5px 12px;border:1px solid var(--border);border-radius:6px;background:var(--canvas-default);color:var(--fg);font:inherit;line-height:20px;box-shadow:inset 0 1px 0 rgba(208,215,222,.2)}input[type=date]{display:block;-webkit-appearance:none;appearance:none}input[type=date]::-webkit-date-and-time-value{min-height:20px;margin:0;text-align:left}input[type=date]::-webkit-datetime-edit{padding:0}input[type=date]::-webkit-calendar-picker-indicator{flex:0 0 auto;margin:0 0 0 auto;padding:0}input::placeholder{color:var(--fg-muted);opacity:1}input:focus,select:focus{border-color:var(--focus);outline:2px solid color-mix(in srgb,var(--focus) 30%,transparent);outline-offset:-1px}
button,.Button{-webkit-appearance:none;appearance:none;display:inline-flex;align-items:center;justify-content:center;height:32px;min-height:32px;padding:0 12px;border:1px solid var(--border);border-radius:6px;background:var(--canvas-subtle);color:var(--fg);font:600 12px/1 var(--font);text-decoration:none;white-space:nowrap;box-shadow:var(--shadow);cursor:pointer}button:hover,.Button:hover{background:var(--canvas-default);border-color:var(--fg-muted)}button:disabled{opacity:.55;cursor:wait}.Button--primary{border-color:rgba(27,31,36,.15);background:var(--success);color:#fff}.Button--primary:hover{background:var(--success-hover);border-color:rgba(27,31,36,.15)}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.capture-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}.capture-status{display:none;grid-column:1/-1;padding:10px 12px;border:1px solid var(--border);border-radius:6px;background:var(--canvas-subtle);color:var(--fg-muted);font-size:13px}.capture-status[data-state]{display:block}.capture-status[data-state=success]{border-color:color-mix(in srgb,var(--success) 55%,var(--border));background:color-mix(in srgb,var(--success) 12%,var(--canvas-default));color:var(--fg)}.capture-status[data-state=error]{border-color:var(--danger);background:var(--danger-muted);color:var(--fg)}.capture-status a{font-weight:600}
.filter-form{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:12px 8px;align-items:end}.FormControl{display:flex;min-width:0;flex-direction:column;gap:6px}.FormControl-label{color:var(--fg);font-size:12px;font-weight:600;line-height:1.25}.FormControl--q{grid-column:span 3}.FormControl--title{grid-column:span 2}.FormControl--url{grid-column:span 3}.FormControl--date{grid-column:span 2}.FormControl--status{grid-column:span 4}.FormControl--sort,.FormControl--limit{grid-column:span 2}.filter-submit{grid-column:span 4;align-self:end}
.active-filters{padding:10px 16px;display:flex;align-items:center;flex-wrap:wrap;gap:6px;border-top:1px solid var(--border)}.active-filters-label{margin-right:2px;color:var(--fg-muted);font-size:12px;font-weight:600}.filter-chip{display:inline-flex;align-items:center;gap:7px;max-width:320px;padding:3px 8px;border:1px solid var(--border);border-radius:2em;background:var(--canvas-subtle);color:var(--fg);font-size:12px;text-decoration:none}.filter-chip span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.filter-chip b{color:var(--fg-muted);font-size:15px;line-height:1}.filter-chip:hover{border-color:var(--fg-muted);background:var(--canvas-default)}.clear-filters{margin-left:4px;font-size:12px;font-weight:600}.tag-cloud{padding:12px 16px;display:flex;flex-wrap:wrap;gap:6px;border-top:1px solid var(--border)}.tag{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid transparent;border-radius:2em;background:var(--canvas-subtle);color:var(--accent);font-size:12px;font-weight:600;text-decoration:none}.tag:hover{border-color:var(--border)}.tag.active{background:var(--accent-emphasis);color:#fff}.tag span{color:inherit;opacity:.75}
.results-header{min-height:48px;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--border);background:var(--canvas-subtle)}.results-summary{color:var(--fg-muted)}.results-summary strong{color:var(--fg)}.failed-link{font-size:12px;text-decoration:none}.failed-link:hover{text-decoration:underline}
ul{list-style:none;margin:0;padding:0}.item{position:relative;padding:16px;border-bottom:1px solid var(--border-muted)}.item:last-child{border-bottom:0}.item:hover{background:color-mix(in srgb,var(--canvas-subtle) 55%,transparent)}.item-heading{display:flex;gap:16px;align-items:flex-start}.item-title{min-width:0;flex:1}.item-title a{color:var(--accent);font-size:16px;font-weight:600;text-decoration:none}.item-title a:hover{text-decoration:underline}.item-facts{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:5px;color:var(--fg-muted);font-size:12px}.item-facts a{color:inherit;text-decoration:none}.item-facts a:hover{color:var(--accent);text-decoration:underline}.domain{font-weight:600}.item-tags{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.item-more{position:relative;flex:0 0 auto}.item-more>summary{display:inline-flex;align-items:center;justify-content:center;min-height:32px;padding:0 10px;border:1px solid transparent;border-radius:6px;color:var(--fg-muted);font-size:12px;font-weight:600;cursor:pointer;list-style:none}.item-more>summary::-webkit-details-marker{display:none}.item-more>summary::after{content:'▾';margin-left:5px;font-size:10px}.item-more>summary:hover,.item-more[open]>summary{border-color:var(--border);background:var(--canvas-default);color:var(--fg)}.item-menu{position:absolute;z-index:20;top:calc(100% + 4px);right:0;width:230px;padding:6px 0;border:1px solid var(--border);border-radius:8px;background:var(--canvas-default);box-shadow:0 8px 24px rgba(31,35,40,.18)}.item-menu-group{padding:6px}.item-menu-group+.item-menu-group{border-top:1px solid var(--border-muted)}.item-menu-label{display:block;padding:2px 8px 5px;color:var(--fg-muted);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}.item-menu a,.item-menu button{display:flex;width:100%;min-height:34px;height:auto;align-items:center;justify-content:flex-start;gap:7px;margin:0;padding:7px 8px;border:0;border-radius:5px;background:transparent;box-shadow:none;color:var(--fg);font:13px/1.3 var(--font);text-align:left;text-decoration:none}.item-menu a:hover,.item-menu button:hover{background:var(--canvas-subtle)}.item-menu .delete{color:var(--danger)}.item-menu .delete:hover{background:var(--danger-muted)}.tag-editor{margin:3px 2px 7px;padding:8px;border:1px solid var(--border-muted);border-radius:6px;background:var(--canvas-subtle)}.tag-editor-list{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}.tag-editor-pill{display:inline-flex;align-items:center;gap:3px;padding:2px 3px 2px 7px;border:1px solid var(--border);border-radius:2em;background:var(--canvas-default);font-size:12px}.item-menu .tag-editor-remove{display:inline-flex;width:24px;min-height:24px;height:24px;padding:0;justify-content:center;border-radius:50%;color:var(--danger);font-size:16px}.tag-editor-empty,.tag-editor-status{margin:0 0 7px;color:var(--fg-muted);font-size:12px}.tag-editor-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:5px}.tag-editor-form input{min-width:0;height:32px;padding:5px 8px}.item-menu .tag-editor-form button{width:auto;min-height:32px;height:32px;padding:0 9px;border:1px solid var(--border);background:var(--canvas-default);font-weight:600}.capture-warnings,.capture-error{margin-top:8px;color:#9a6700;font-size:12px}.capture-warnings ul{list-style:disc;padding-left:20px}.capture-error{color:var(--danger)}.empty-state{padding:40px 16px;color:var(--fg-muted);text-align:center}
.pagination{padding:8px 0 24px;display:flex;justify-content:center;gap:8px}.pagination a{display:inline-flex;padding:5px 12px;border:1px solid transparent;border-radius:6px;color:var(--accent);font-weight:600;text-decoration:none}.pagination a:hover{border-color:var(--border);background:var(--canvas-default)}
@media(max-width:800px){.filter-form{grid-template-columns:repeat(4,minmax(0,1fr))}.FormControl--q{grid-column:1/-1}.FormControl--title,.FormControl--url,.FormControl--date,.FormControl--status{grid-column:span 2}.FormControl--sort,.FormControl--limit{grid-column:span 1}.filter-submit{grid-column:1/-1}.item-menu{position:fixed;left:16px;right:16px;top:auto;bottom:16px;width:auto;max-height:calc(100vh - 32px);overflow:auto}}
@media(max-width:600px){.app-header-inner{min-height:56px;padding:0 16px}.page{padding:16px}.page-heading h1{font-size:20px}.Box-body{padding:12px}.capture-form{grid-template-columns:minmax(0,1fr)}.capture-form button{width:100%}.filter-form{grid-template-columns:repeat(2,minmax(0,1fr))}.FormControl--q,.FormControl--title,.FormControl--url,.FormControl--status,.filter-submit{grid-column:1/-1}.FormControl--date,.FormControl--sort,.FormControl--limit{grid-column:span 1}input[type=search],input[type=url],input[type=date],select,button,.Button{height:44px;min-height:44px}input[type=date]::-webkit-date-and-time-value{min-height:32px}.item{padding:16px}.item-more>summary{min-height:44px}.item-menu{position:fixed;left:16px;right:16px;top:auto;bottom:16px;width:auto;max-height:calc(100vh - 32px);overflow:auto}.item-menu a,.item-menu button{min-height:44px}.results-header{align-items:flex-start;flex-direction:column}.app-context{display:none}}
@media(max-width:400px){.filter-form{grid-template-columns:minmax(0,1fr)}.filter-form>*{grid-column:1!important}.item-heading{gap:8px}}
</style>
</head>
<body>
<header class="app-header">
  <div class="app-header-inner">
    <a class="brand" href="/" aria-label="Packrat home"><svg width="24" height="24" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 1A1.75 1.75 0 0 0 1 2.75v10.5C1 14.216 1.784 15 2.75 15h10.5A1.75 1.75 0 0 0 15 13.25V2.75A1.75 1.75 0 0 0 13.25 1Zm0 1.5h10.5a.25.25 0 0 1 .25.25V5h-11V2.75a.25.25 0 0 1 .25-.25ZM2.5 6.5h11v6.75a.25.25 0 0 1-.25.25H2.75a.25.25 0 0 1-.25-.25Zm3.25 1a.75.75 0 0 0 0 1.5h4.5a.75.75 0 0 0 0-1.5Z"/></svg><span>Packrat</span></a>
    <span class="app-context">Web archive</span>
    <a class="status-link" href="/status">Queue status</a>
  </div>
</header>
<main class="page">
  <div class="page-heading"><div><h1>Captures <span class="Counter">${totalCount}</span></h1><p>Search, read, and export your permanent web archive.</p></div></div>
  <section class="Box" aria-labelledby="archive-heading">
    <div class="Box-header"><h2 class="Box-title" id="archive-heading">Archive a URL</h2></div>
    <div class="Box-body"><form class="capture-form" id="capture-form">
      <input type="url" id="capture-url" value="${esc(archive)}" placeholder="https://example.com/article" aria-label="URL to archive" required>
      <button class="Button--primary" type="submit">Archive URL</button>
      <div class="capture-status" id="capture-status" role="status" aria-live="polite" aria-atomic="true"></div>
    </form></div>
  </section>
  <section class="Box" aria-labelledby="filter-heading">
    <div class="Box-header"><h2 class="Box-title" id="filter-heading">Filter captures</h2></div>
    <div class="Box-body"><form class="filter-form" method="GET" action="/">
      <label class="FormControl FormControl--q"><span class="FormControl-label">Search content</span><input type="search" name="q" value="${esc(q)}" placeholder="Words or phrase" autocomplete="off"></label>
      <label class="FormControl FormControl--title"><span class="FormControl-label">Title</span><input type="search" name="title" value="${esc(url.searchParams.get('title') ?? '')}" placeholder="Capture title"></label>
      <label class="FormControl FormControl--url"><span class="FormControl-label">URL</span><input type="search" name="url" value="${esc(url.searchParams.get('url') ?? '')}" placeholder="Domain or path"></label>
      <label class="FormControl FormControl--date"><span class="FormControl-label">From date</span><input type="date" name="dateFrom" value="${esc(url.searchParams.get('dateFrom') ?? '')}"></label>
      <label class="FormControl FormControl--date"><span class="FormControl-label">To date</span><input type="date" name="dateTo" value="${esc(url.searchParams.get('dateTo') ?? '')}"></label>
      <label class="FormControl FormControl--status"><span class="FormControl-label">Status</span><select name="status"><option value=""${!url.searchParams.get('status') ? ' selected' : ''}>Succeeded</option><option value="all"${url.searchParams.get('status') === 'all' ? ' selected' : ''}>All status</option><option value="failed"${url.searchParams.get('status') === 'failed' ? ' selected' : ''}>Failed</option></select></label>
      <label class="FormControl FormControl--sort"><span class="FormControl-label">Sort by</span><select name="sort"><option value="relevance"${sort === 'relevance' ? ' selected' : ''}>Relevance</option><option value="newest"${sort === 'newest' ? ' selected' : ''}>Newest</option><option value="oldest"${sort === 'oldest' ? ' selected' : ''}>Oldest</option></select></label>
      <label class="FormControl FormControl--limit"><span class="FormControl-label">Per page</span><select name="limit"><option${limit === 25 ? ' selected' : ''}>25</option><option${limit === 50 ? ' selected' : ''}>50</option><option${limit === 100 ? ' selected' : ''}>100</option><option${limit === 200 ? ' selected' : ''}>200</option></select></label>
      <button class="filter-submit" type="submit">Apply filters</button>
    </form></div>
    ${activeFilterBar}
    ${tagCloud}
  </section>
  <section class="Box results-box" aria-label="Capture results">
    <div class="results-header"><div class="results-summary"><strong>${matchingCount.toLocaleString()} capture${matchingCount === 1 ? '' : 's'}</strong>${matchingCount ? ` · showing ${offset + 1}–${Math.min(offset + rows.length, matchingCount)}` : ''}${q ? ` · matching “${esc(q)}”` : ''}${domain ? ` · from ${esc(domain)}` : ''}${tag ? ` · tagged ${esc(tag)}` : ''}</div><a class="failed-link" href="${filterHref('status', 'failed')}">${failedCount} failed</a></div>
    <ul>${searchError ? `<li class="capture-error" style="padding:16px">${esc(searchError)}</li>` : items || '<li class="empty-state">No captures found.</li>'}</ul>
  </section>
  ${pagination}
</main>
<script>${INDEX_CLIENT_SCRIPT}</script>
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

interface QueueStatusJob {
  id: number;
  kind: string;
  status: string;
  capture_id: number | null;
  payload: string | null;
  error: string | null;
  attempt_count: number;
  max_attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function renderStatusPage(db: Database, queue: JobQueue): Response {
  const status = buildStatus(db, queue);
  const counts = db.query<{ status: string; count: number }, []>(
    `SELECT status,COUNT(*) count FROM jobs WHERE kind='capture' GROUP BY status`,
  ).all();
  const count = (name: string) => counts.find((item) => item.status === name)?.count ?? 0;
  const jobs = db.query<QueueStatusJob, []>(`
    SELECT id,kind,status,capture_id,payload,error,attempt_count,max_attempts,queued_at,started_at,finished_at
    FROM jobs WHERE kind='capture'
    ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,
             CASE WHEN status IN ('running','queued') THEN id END ASC,
             CASE WHEN status NOT IN ('running','queued') THEN id END DESC
    LIMIT 50
  `).all();
  const now = new Date();
  const jobRows = jobs.map((job) => {
    const payload = safeObjectJson(job.payload);
    const target = typeof payload.url === 'string' ? payload.url : '';
    const targetHref = safeExternalHref(target);
    const timingEnd = job.finished_at ?? now.toISOString();
    const duration = job.started_at ? formatDuration(Date.parse(timingEnd) - Date.parse(job.started_at)) : 'Not started';
    const attemptText = `${job.attempt_count} of ${job.max_attempts}`;
    const captureLink = job.capture_id ? `<a href="/captures/${job.capture_id}">Capture #${job.capture_id}</a>` : '—';
    const error = job.error ? `<div class="job-error">${esc(job.error)}</div>` : '';
    const targetLabel = target ? esc(target) : '(URL unavailable)';
    const targetCell = targetHref ? `<a class="job-url" href="${esc(targetHref)}" rel="noopener noreferrer" target="_blank">${targetLabel}</a>` : `<span class="job-url">${targetLabel}</span>`;
    return `<tr data-status="${esc(job.status)}"><td><a href="/api/jobs/${job.id}">#${job.id}</a></td><td><span class="status-badge status-${esc(job.status)}">${esc(job.status)}</span></td><td>${targetCell}${error}</td><td>${attemptText}</td><td><time datetime="${esc(job.queued_at)}">${esc(formatStatusTime(job.queued_at))}</time></td><td>${esc(duration)}</td><td>${captureLink}</td></tr>`;
  }).join('');
  const busy = status.jobQueue.running > 0 || status.jobQueue.queued > 0;
  const queueSummary = status.jobQueue.running > 0
    ? `${status.jobQueue.running} running, ${status.jobQueue.queued} waiting`
    : status.jobQueue.queued > 0 ? `${status.jobQueue.queued} waiting for a worker` : 'Queue is idle';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="10"><title>Queue status — Packrat</title><style>
:root{color-scheme:light;--bg:#f6f8fa;--surface:#fff;--subtle:#f6f8fa;--fg:#1f2328;--muted:#59636e;--border:#d1d9e0;--accent:#0969da;--success:#1a7f37;--success-bg:#dafbe1;--warning:#9a6700;--warning-bg:#fff8c5;--danger:#cf222e;--danger-bg:#ffebe9;--header:#25292e;--header-fg:#fff;--font:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d1117;--surface:#161b22;--subtle:#21262d;--fg:#f0f6fc;--muted:#8b949e;--border:#30363d;--accent:#58a6ff;--success:#3fb950;--success-bg:#12361f;--warning:#d29922;--warning-bg:#3d2f05;--danger:#f85149;--danger-bg:#3d1214;--header:#010409;--header-fg:#f0f6fc}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 var(--font)}a{color:var(--accent)}header{background:var(--header);color:var(--header-fg)}.header-inner{max-width:1280px;min-height:64px;margin:auto;padding:0 24px;display:flex;align-items:center;gap:16px}.brand{color:inherit;font-size:16px;font-weight:600;text-decoration:none}.context{color:rgba(255,255,255,.75)}.api-link{margin-left:auto;color:inherit}.page{max-width:1280px;margin:auto;padding:24px}.heading{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}.heading h1{margin:0;font-size:24px;font-weight:400}.heading p{margin:4px 0 0;color:var(--muted)}.refresh{color:var(--muted);font-size:12px;white-space:nowrap}.summary{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin-bottom:20px}.card{padding:16px;border:1px solid var(--border);border-radius:6px;background:var(--surface)}.card strong{display:block;font-size:24px;line-height:1.15}.card span{color:var(--muted);font-size:12px}.queue-state{grid-column:span 2}.queue-state strong{font-size:18px}.queue-state.busy{border-color:var(--warning);background:var(--warning-bg)}.panel{border:1px solid var(--border);border-radius:6px;background:var(--surface);overflow:hidden}.panel-header{display:flex;justify-content:space-between;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--subtle)}.panel-header h2{margin:0;font-size:14px}.table-scroll{overflow-x:auto}table{width:100%;border-collapse:collapse}th,td{padding:10px 12px;border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th{color:var(--muted);font-size:12px;font-weight:600;white-space:nowrap}tbody tr:last-child td{border-bottom:0}.job-url{display:block;max-width:580px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.job-error{max-width:680px;margin-top:4px;color:var(--danger);font-size:12px;overflow-wrap:anywhere}.status-badge{display:inline-block;padding:2px 7px;border-radius:2em;background:var(--subtle);font-size:12px;font-weight:600}.status-running,.status-queued{color:var(--warning);background:var(--warning-bg)}.status-succeeded{color:var(--success);background:var(--success-bg)}.status-failed,.status-cancelled{color:var(--danger);background:var(--danger-bg)}.empty{padding:32px;color:var(--muted);text-align:center}@media(max-width:850px){.summary{grid-template-columns:repeat(3,minmax(0,1fr))}.queue-state{grid-column:span 3}}@media(max-width:560px){.header-inner,.page{padding-left:16px;padding-right:16px}.context{display:none}.heading{display:block}.refresh{margin-top:8px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.queue-state{grid-column:span 2}.card{padding:12px}th,td{padding:9px 10px}}
</style></head><body><header><div class="header-inner"><a class="brand" href="/">Packrat</a><span class="context">Queue status</span><a class="api-link" href="/api/status">JSON status</a></div></header><main class="page"><div class="heading"><div><h1>Capture queue</h1><p>Live worker state and the 50 most relevant capture jobs.</p></div><div class="refresh">Updated ${esc(formatStatusTime(now.toISOString()))} · refreshes every 10 seconds</div></div><section class="summary" aria-label="Queue summary"><div class="card queue-state${busy ? ' busy' : ''}"><strong>${esc(queueSummary)}</strong><span>${status.jobQueue.activeWorkers} active worker${status.jobQueue.activeWorkers === 1 ? '' : 's'}</span></div><div class="card"><strong>${count('queued')}</strong><span>Queued</span></div><div class="card"><strong>${count('running')}</strong><span>Running</span></div><div class="card"><strong>${count('succeeded')}</strong><span>Succeeded jobs</span></div><div class="card"><strong>${count('failed') + count('cancelled')}</strong><span>Failed or cancelled</span></div></section><section class="panel"><div class="panel-header"><h2>Active and recent jobs</h2><span>${status.captures.succeeded.toLocaleString()} successful captures · ${status.captures.failed.toLocaleString()} failed</span></div><div class="table-scroll"><table><thead><tr><th>Job</th><th>Status</th><th>Target and error</th><th>Attempts</th><th>Queued</th><th>Run time</th><th>Result</th></tr></thead><tbody>${jobRows || '<tr><td class="empty" colspan="7">No capture jobs yet.</td></tr>'}</tbody></table></div></section></main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }});
}

function safeObjectJson(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

function formatStatusTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('en-GB', { dateStyle:'medium', timeStyle:'medium', timeZone:'UTC' }) + ' UTC' : value;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

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

function summariseCapture(c: CaptureMetadataRow) {
  return {
    id: c.id, title: c.title, mode: c.mode, status: c.status,
    sourceUrl: c.source_url, finalUrl: c.final_url,
    capturedAt: c.captured_at, htmlSizeBytes: c.html_size,
    excerpt: c.excerpt, contentHash: c.content_hash,
    sourcePdf: c.source_pdf_sha256 ? {
      sha256: c.source_pdf_sha256,
      sizeBytes: c.source_pdf_size,
      extractionStatus: c.source_pdf_extraction_status,
    } : null,
    author: c.author, siteName: c.site_name, publishedAt: c.published_at,
    warnings: parseWarnings(c.warnings), error: c.error, note: c.note,
    captureTool: c.capture_tool, captureDurationMs: c.capture_duration_ms,
  };
}

function summariseCaptureForApi(c: CaptureMetadataRow) {
  const summary = summariseCapture(c);
  let formats: string[] = [];
  if (c.status === 'succeeded' && c.body_format) {
    formats = ['html', 'article-html', 'markdown', 'markdown-zip', 'epub', 'pdf'];
    if (c.body_format === 'mhtml') formats.unshift('mhtml');
  }
  if (c.status === 'succeeded' && c.source_pdf_sha256) {
    formats.push('source-pdf');
    if (c.source_pdf_extraction_status === 'succeeded' || c.source_pdf_extraction_status === 'image_only') {
      formats.push('source-pdf-text');
    }
  }
  return {
    ...summary,
    availableFormats: formats,
    links: {
      metadata: `/api/captures/${c.id}`,
      content: Object.fromEntries(formats.map((format) => [format, `/api/captures/${c.id}/content/${format}`])),
    },
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

function renderMarkdownView(id: number, title: string, markdown: string, archivedImageCount: number, remoteImageCount: number, remoteImages: boolean, sourceHref: string | null): Response {
  const content = renderMarkdownHtml(markdown, remoteImages);
  const enableHref = `/captures/${id}/markdown?remote=1`;
  const sourceLink = sourceHref ? ` · ${renderOriginalLink(sourceHref)}` : '';
  const archivedNotice = archivedImageCount ? `<p class="archive-notice">Showing ${archivedImageCount} image${archivedImageCount === 1 ? '' : 's'} stored inside this capture.</p>` : '';
  const remoteNotice = remoteImageCount === 0 ? '' : remoteImages
    ? `<p class="warning">${remoteImageCount} image${remoteImageCount === 1 ? '' : 's'} missing from the archive ${remoteImageCount === 1 ? 'is' : 'are'} loaded from the original host.</p>`
    : `<p class="warning">${remoteImageCount} image${remoteImageCount === 1 ? '' : 's'} ${remoteImageCount === 1 ? 'was' : 'were'} not stored in this capture. Loading ${remoteImageCount === 1 ? 'it' : 'them'} contacts the original hosts and may disclose your IP address and browser headers. <a href="${enableHref}">Enable remote images for this view</a></p>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — Markdown</title><style>:root{color-scheme:light;--bg:#fff;--surface:#f4f5f7;--fg:#202124;--muted:#5f6368;--border:#c7cbd1;--accent:#0057b7;--notice-bg:#fff4ce;--notice-fg:#4f3b00;--notice-border:#b88a00;--archive-bg:#dafbe1;--archive-fg:#116329;--archive-border:#4ac26b}@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#151617;--surface:#252729;--fg:#f1f3f4;--muted:#bdc1c6;--border:#62666b;--accent:#8fc5ff;--notice-bg:#403711;--notice-fg:#fff2b2;--notice-border:#ad8b16;--archive-bg:#12361f;--archive-fg:#7ee787;--archive-border:#238636}}*{box-sizing:border-box}body{max-width:760px;margin:auto;padding:1rem;background:var(--bg);color:var(--fg);font:17px/1.6 Georgia,serif}a{color:var(--accent)}nav,.warning,.archive-notice{font:14px system-ui,sans-serif}.warning,.archive-notice{padding:.8rem;border:1px solid;border-radius:4px}.warning{background:var(--notice-bg);color:var(--notice-fg);border-color:var(--notice-border)}.warning a{color:inherit;font-weight:700}.archive-notice{background:var(--archive-bg);color:var(--archive-fg);border-color:var(--archive-border)}img{display:block;max-width:100%;height:auto;margin:1.5rem auto}main{min-width:0}pre{max-width:100%;overflow:auto;background:var(--surface);border:1px solid var(--border);padding:1rem}code{background:var(--surface)}:not(pre)>code{overflow-wrap:anywhere;word-break:break-word}p,li,blockquote,figcaption{overflow-wrap:anywhere;word-break:break-word}.image-placeholder{display:block;padding:1rem;background:var(--surface);color:var(--muted);border:1px solid var(--border)}.table-scroll{max-width:100%;margin:1.5rem 0;overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--border);border-radius:6px}table{width:100%;min-width:36rem;border-collapse:collapse;font:14px/1.45 system-ui,sans-serif}th,td{padding:.55rem .7rem;border-right:1px solid var(--border);border-bottom:1px solid var(--border);text-align:left;vertical-align:top}th:last-child,td:last-child{border-right:0}tbody tr:last-child td{border-bottom:0}th{background:var(--surface);font-weight:600}tbody tr:nth-child(even){background:color-mix(in srgb,var(--surface) 55%,transparent)}</style></head><body><nav><a href="/captures/${id}">Archived HTML</a> · <strong>Markdown</strong> · <a href="/captures/${id}/markdown.raw">Raw Markdown</a>${sourceLink}</nav>${archivedNotice}${remoteNotice}<main>${content}</main></body></html>`;
  return new Response(html, { headers: {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': remoteImages ? "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: http:; base-uri 'none'; frame-ancestors 'none'" : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  }});
}

async function serveMarkdownImage(db: Database, captureId: number, index: number, head: boolean): Promise<Response> {
  if (!Number.isSafeInteger(index) || index < 0) return json404('Archived image not found');
  const capture = getCaptureById(db, captureId);
  if (!capture || capture.status !== 'succeeded') {
    markdownAssetCache.delete(captureId);
    return json404('Archived image not found');
  }
  let cached = markdownAssetCache.get(captureId);
  let uncachedAssets: MarkdownAsset[] | null = null;
  if (!cached) {
    const rendered = await renderRemoteMarkdown(db, captureId, { archivedImageBase:`/captures/${captureId}/images` });
    if (!rendered) return json404('Capture not found or not yet succeeded');
    uncachedAssets = rendered.assets;
    rememberMarkdownAssets(captureId, rendered.assets);
    cached = markdownAssetCache.get(captureId);
  }
  const asset = cached?.assets[index] ?? uncachedAssets?.[index];
  if (!asset || !/^image\/(?:avif|bmp|gif|jpeg|jpg|png|webp|x-icon)$/i.test(asset.mime)) return json404('Archived image not found');
  if (cached) cached.touchedAt = Date.now();
  return new Response(head ? null : new Blob([Uint8Array.from(asset.data).buffer]), { headers: {
    'Content-Type': asset.mime, 'Content-Length': String(asset.data.byteLength),
    'Cache-Control': 'private, max-age=86400, immutable', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  }});
}

function rememberMarkdownAssets(captureId: number, assets: MarkdownAsset[]): void {
  markdownAssetCache.delete(captureId);
  const bytes = assets.reduce((sum, asset) => sum + asset.data.byteLength, 0);
  if (bytes > MAX_MARKDOWN_ASSET_CACHE_BYTES) return;
  markdownAssetCache.set(captureId, { assets, bytes, touchedAt:Date.now() });
  let total = Array.from(markdownAssetCache.values()).reduce((sum, item) => sum + item.bytes, 0);
  while (total > MAX_MARKDOWN_ASSET_CACHE_BYTES && markdownAssetCache.size > 1) {
    const oldest = Array.from(markdownAssetCache.entries()).sort((a, b) => a[1].touchedAt - b[1].touchedAt)[0];
    markdownAssetCache.delete(oldest[0]);
    total -= oldest[1].bytes;
  }
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

function captureAttribution(author: string | null, siteName: string | null, domain: string): string | null {
  const cleanAuthor = author?.trim();
  if (cleanAuthor) return `by ${cleanAuthor}`;
  const cleanSite = siteName?.trim();
  if (!cleanSite) return null;
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const domainLabel = domain.replace(/^www\./i, '').split('.')[0] ?? domain;
  return normalise(cleanSite) === normalise(domainLabel) ? null : cleanSite;
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch { return null; }
}

function renderOriginalLink(value: string, style = ''): string {
  const href = safeExternalHref(value);
  if (!href) return '';
  const styleAttr = style ? ` style="${style}"` : '';
  return `<a${styleAttr} href="${esc(href)}" rel="noopener noreferrer" target="_blank">Original <span aria-hidden="true">↗</span></a>`;
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
