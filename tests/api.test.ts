import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { attachSourcePdf, getOrCreateUrl, insertCapture, openDatabase, runMigrations, savePdfExtraction } from '../src/db/index.js';

const BOUNDARY = '----PackratApiFixture';
const MHTML = [
  'From: <Saved by Blink>',
  'Snapshot-Content-Location: https://example.com/canonical',
  `Content-Type: multipart/related; type="text/html"; boundary="${BOUNDARY}"`,
  '',
  `--${BOUNDARY}`,
  'Content-Type: text/html',
  'Content-Transfer-Encoding: quoted-printable',
  'Content-Location: https://example.com/canonical',
  '',
  '<!doctype html><html lang="en"><head><title>Canonical API fixture</title></head><body><main><article><h1>Canonical API fixture</h1><p>This searchable canonical article has enough useful text for deterministic Markdown extraction and API validation.</p><p>A second paragraph keeps the article structure clear and stable.</p></article></main></body></html>',
  `--${BOUNDARY}--`,
  '',
].join('\r\n');

const LEGACY_HTML = '<!doctype html><html><head><title>Legacy API fixture</title></head><body><div class="packrat-content"><h1>Legacy API fixture</h1><p>Legacy body text.</p></div></body></html>';

let dir: string;
let dbPath: string;
let base: string;
let server: Subprocess;
let canonicalId: number;
let legacyId: number;
let sourcePdfId: number;
let sourcePdfBytes: Buffer;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'packrat-api-test-'));
  dbPath = join(dir, 'packrat.sqlite');
  const db = openDatabase(dbPath);
  runMigrations(db);
  canonicalId = addCapture(db, 'https://example.com/canonical', 'Canonical API fixture', Buffer.from(MHTML), 'full_page');
  legacyId = addCapture(db, 'https://legacy.example.com/article', 'Legacy API fixture', Buffer.from(LEGACY_HTML), 'article');
  const pdfUrl = getOrCreateUrl(db, 'https://example.com/source.pdf', 'https://example.com/source.pdf');
  sourcePdfId = insertCapture(db, { url_id:pdfUrl.id,source_url:pdfUrl.original,final_url:pdfUrl.original,html:null,compression:'none',content_hash:null,html_size:null,title:'Source PDF fixture',author:null,site_name:null,published_at:null,excerpt:null,lang:'en',extracted_text:'Source PDF fixture text',mode:'pdf',status:'succeeded',capture_tool:'test/api',warnings:null });
  sourcePdfBytes = Buffer.from('%PDF-1.4\nsource-api-fixture\n%%EOF\n');
  attachSourcePdf(db, { captureId:sourcePdfId,bytes:sourcePdfBytes,sourceKind:'direct',sourceMime:'application/pdf',sourceFilename:'source.pdf' });
  savePdfExtraction(db, sourcePdfId, { status:'succeeded',pageCount:1,text:'Extracted source PDF text',textBytes:25,textTruncated:false,warnings:[],error:null,extractor:'test' });
  db.close();

  const port = 35_000 + Math.floor(Math.random() * 10_000);
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: join(import.meta.dir, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PACKRAT_BASE_URL: base,
      PACKRAT_DB: dbPath,
      PACKRAT_AUTH_DISABLED: '1',
      PACKRAT_MAX_CONCURRENT_CAPTURES: '1',
    },
    stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
  });

  for (let attempt = 0; attempt < 100; attempt++) {
    if (await exited(server)) throw new Error(`API test server exited before startup: ${await readStderr(server)}`);
    try {
      const response = await fetch(`${base}/api/status`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(25);
  }
  throw new Error('API test server did not start');
}, 10_000);

afterAll(async () => {
  if (server) {
    server.kill('SIGTERM');
    await server.exited;
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('agent capture API', () => {
  test('searches captures and reports stable format links and query errors', async () => {
    const response = await fetch(`${base}/api/captures?q=searchable&mode=full_page&sort=relevance&limit=1`);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.total).toBe(1);
    expect(result.captures[0].id).toBe(canonicalId);
    expect(result.captures[0].availableFormats).toEqual(['mhtml', 'html', 'article-html', 'markdown', 'markdown-zip', 'epub', 'pdf']);
    expect(result.captures[0].links.content['article-html']).toBe(`/api/captures/${canonicalId}/content/article-html`);
    expect(result.captures[0].links.content.markdown).toBe(`/api/captures/${canonicalId}/content/markdown`);

    const malformed = await fetch(`${base}/api/captures?q=${encodeURIComponent('"unterminated')}`);
    expect(malformed.status).toBe(400);
    expect((await malformed.json() as any).error).toContain('Invalid search query');
  });

  test('exposes the original URL in capture listings and reading views', async () => {
    const source = 'https://example.com/canonical';
    const expectedLink = `href="${source}" rel="noopener noreferrer" target="_blank">Original`;

    const index = await fetch(base).then((response) => response.text());
    expect(index).toContain(`class="original-link" ${expectedLink}`);
    expect(index).not.toContain('name="mode"');
    expect(index).not.toContain('Capture mode');
    expect(index).toContain('input[type=date]::-webkit-date-and-time-value');

    const writeDb = openDatabase(dbPath);
    const metadataUrl = getOrCreateUrl(writeDb, 'https://metadata.example.com/item', 'https://metadata.example.com/item');
    const metadataId = insertCapture(writeDb, { url_id:metadataUrl.id, source_url:metadataUrl.original, final_url:metadataUrl.original, html:null, compression:'none', content_hash:null, html_size:null, title:'Metadata record', author:null, site_name:null, published_at:null, excerpt:null, lang:null, extracted_text:'Metadata record', mode:'metadata_only', status:'succeeded', capture_tool:'test', warnings:JSON.stringify(['No usable body']) });
    writeDb.exec("INSERT INTO archivebox_imports(ab_id,ab_url,ab_timestamp,capture_id,outcome,outcome_detail,processed_at) VALUES ('meta-source',?, '1700000000.1',?, 'imported','metadata_only',strftime('%Y-%m-%dT%H:%M:%SZ','now'))", [metadataUrl.original, metadataId]);
    writeDb.close();
    const metadataPage = await fetch(`${base}/captures/${metadataId}`, { headers:{ Accept:'text/html' } });
    expect(metadataPage.status).toBe(200);
    const metadataHtml = await metadataPage.text();
    expect(metadataHtml).toContain('No archived page body is available.');
    expect(metadataHtml).toContain('meta-source');
    expect(metadataHtml).not.toContain('href="/captures/' + metadataId + '/article"');
    const updatedIndex = await fetch(base).then((response) => response.text());
    expect(updatedIndex).toContain(`href="/captures/${metadataId}">Metadata record</a>`);
    expect(updatedIndex).toContain('Metadata and provenance');
    expect(updatedIndex).not.toContain(`href="/captures/${metadataId}/export/html"`);
    expect(index).toContain('class="capture-size" title="Canonical capture size"');
    expect(index).toContain('>API fixtures</span>');
    expect(index).not.toContain('Full-page capture');
    expect(index).not.toContain('Original source');

    for (const path of [
      `/captures/${canonicalId}`,
      `/captures/${canonicalId}/article`,
      `/captures/${canonicalId}/markdown`,
    ]) {
      const response = await fetch(`${base}${path}`, { headers: { Accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(expectedLink);
    }
  });

  test('renders a human queue monitor while preserving JSON status', async () => {
    const writeDb = openDatabase(dbPath);
    writeDb.exec(`INSERT INTO jobs(kind,status,capture_id,payload,error,attempt_count,max_attempts,queued_at,started_at,finished_at)
      VALUES ('capture','succeeded',?,? ,NULL,1,3,'2026-08-18T18:00:00Z','2026-08-18T18:00:01Z','2026-08-18T18:00:05Z'),
             ('capture','failed',NULL,? ,?,2,3,'2026-08-18T18:01:00Z','2026-08-18T18:01:01Z','2026-08-18T18:01:11Z')`, [canonicalId, JSON.stringify({url:'https://example.com/canonical'}), JSON.stringify({url:'https://failed.example.com/article'}), '<script>alert("unsafe")</script>']);
    writeDb.close();

    const response = await fetch(`${base}/status`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('<title>Queue status — Packrat</title>');
    expect(html).toContain('http-equiv="refresh" content="10"');
    expect(html).toContain('Queue is idle');
    expect(html).toContain('failed.example.com/article');
    expect(html).toContain('&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert("unsafe")</script>');
    expect(html).toContain(`href="/captures/${canonicalId}">Capture #${canonicalId}</a>`);
    expect(html).toContain('2 of 3');
    expect(html).toContain('href="/api/status">JSON status</a>');

    const json = await fetch(`${base}/api/status`);
    expect(json.headers.get('content-type')).toContain('application/json');
    expect((await json.json() as any).jobQueue).toEqual({ queued:0, running:0, activeWorkers:0 });
    const index = await fetch(base).then((result) => result.text());
    expect(index).toContain('class="status-link" href="/status">Queue status</a>');
  });

  test('manages per-capture tags and renders individually removable filters', async () => {
    const added = await fetch(`${base}/api/captures/${canonicalId}/tags`, {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ tag:'  reference  ' }),
    });
    expect(added.status).toBe(200);
    expect((await added.json() as any).tags).toEqual(['reference']);

    const page = await fetch(`${base}/?q=canonical&tag=reference&domain=example.com&status=all&sort=oldest&offset=50`).then((response) => response.text());
    expect(page).toContain('class="active-filters"');
    expect(page).toContain('Search: canonical');
    expect(page).toContain('Tag: reference');
    expect(page).toContain('Domain: example.com');
    expect(page).toContain('Status: all');
    expect(page).toContain('Sort: oldest');
    expect(page).toContain('class="clear-filters" href="/"');
    expect(page).toContain('class="manage-tags"');
    expect(page).toContain(`id="tag-editor-${canonicalId}"`);
    expect(page).toContain('q=canonical&amp;domain=example.com&amp;status=all&amp;sort=oldest');
    expect(page).not.toContain('q=canonical&amp;tag=reference&amp;domain=example.com&amp;status=all&amp;sort=oldest&amp;offset=50');

    const removed = await fetch(`${base}/api/captures/${canonicalId}/tags`, {
      method:'DELETE', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ tag:'reference' }),
    });
    expect(removed.status).toBe(200);
    expect((await removed.json() as any).tags).toEqual([]);
    expect((await fetch(`${base}/api/captures/${canonicalId}/tags`).then((response) => response.json()) as any).tags).toEqual([]);
    expect((await fetch(`${base}/api/tags`).then((response) => response.json()) as any).tags).toEqual([]);
    expect((await fetch(`${base}/api/captures/999999/tags`)).status).toBe(404);
  });

  test('serves source PDFs inline or as attachments with HEAD and bounded single ranges', async () => {
    const metadata = await fetch(`${base}/api/captures/${sourcePdfId}`).then((response) => response.json()) as any;
    expect(metadata.availableFormats).toEqual(['source-pdf', 'source-pdf-text']);
    expect(metadata.sourcePdf.sizeBytes).toBe(sourcePdfBytes.byteLength);

    const head = await fetch(`${base}/captures/${sourcePdfId}/source.pdf`, { method:'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(sourcePdfBytes.byteLength));
    expect(head.headers.get('accept-ranges')).toBe('bytes');
    expect(head.headers.get('x-packrat-content-format')).toBe('source-pdf');
    expect(head.headers.get('x-packrat-source-url')).toContain('example.com/source.pdf');
    expect(await head.text()).toBe('');

    const range = await fetch(`${base}/captures/${sourcePdfId}/source.pdf`, { headers:{ Range:'bytes=5-11' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe(`bytes 5-11/${sourcePdfBytes.byteLength}`);
    expect(await range.text()).toBe('1.4\nsou');
    expect((await fetch(`${base}/captures/${sourcePdfId}/source.pdf`, { headers:{ Range:'bytes=0-1,3-4' } })).status).toBe(416);

    const download = await fetch(`${base}/captures/${sourcePdfId}/source.pdf?download=1`);
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(Buffer.from(await download.arrayBuffer()).equals(sourcePdfBytes)).toBe(true);
    const text = await fetch(`${base}/captures/${sourcePdfId}/source.txt`);
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe('Extracted source PDF text');
    const page = await fetch(`${base}/captures/${sourcePdfId}`, { headers:{ Accept:'text/html' } }).then((response) => response.text());
    expect(page).toContain(`/captures/${sourcePdfId}/source.pdf`);
    expect(page).toContain('Download PDF');
  });

  test('serves byte-exact canonical downloads for both MHTML and legacy HTML', async () => {
    const canonical = await fetch(`${base}/captures/${canonicalId}?raw=1`);
    expect(canonical.headers.get('content-type')).toBe('multipart/related');
    expect(Buffer.from(await canonical.arrayBuffer()).equals(Buffer.from(MHTML))).toBe(true);
    const legacy = await fetch(`${base}/captures/${legacyId}?raw=1`);
    expect(legacy.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(Buffer.from(await legacy.arrayBuffer()).equals(Buffer.from(LEGACY_HTML))).toBe(true);
  });

  test('extracts every native format and preserves legacy availability semantics', async () => {
    const expectedTypes: Record<string, string> = {
      mhtml: 'multipart/related',
      html: 'text/html; charset=utf-8',
      'article-html': 'text/html; charset=utf-8',
      markdown: 'text/markdown; charset=utf-8',
      'markdown-zip': 'application/zip',
      epub: 'application/epub+zip',
      pdf: 'application/pdf',
    };
    const signatures: Record<string, string> = { mhtml: 'From: <Saved by Blink>', html: '<!doctype html>', 'article-html': '<!doctype html>', 'markdown-zip': 'PK', epub: 'PK', pdf: '%PDF-' };

    for (const [format, contentType] of Object.entries(expectedTypes)) {
      const response = await fetch(`${base}/api/captures/${canonicalId}/content/${format}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe(contentType);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-packrat-capture-id')).toBe(String(canonicalId));
      expect(response.headers.get('x-packrat-content-format')).toBe(format);
      expect(response.headers.get('x-packrat-content-hash')).toBe(createHash('sha256').update(MHTML).digest('hex'));
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.byteLength).toBeGreaterThan(20);
      if (signatures[format]) expect(body.subarray(0, signatures[format].length).toString()).toBe(signatures[format]);
      if (format === 'html') expect(body.toString()).toContain('http-equiv="Content-Security-Policy"');
      if (format === 'article-html') {
        expect(body.toString()).toContain('packrat-article-style');
        expect(body.toString()).toContain('Canonical API fixture');
      }
      if (format === 'markdown') expect(body.toString()).toContain('Canonical API fixture');
    }

    const legacyMeta = await fetch(`${base}/api/captures/${legacyId}`).then((response) => response.json()) as any;
    expect(legacyMeta.availableFormats).toEqual(['html', 'article-html', 'markdown', 'markdown-zip', 'epub', 'pdf']);
    const unavailable = await fetch(`${base}/api/captures/${legacyId}/content/mhtml`);
    expect(unavailable.status).toBe(409);
    expect((await unavailable.json() as any).error).toContain('unavailable');
    expect((await fetch(`${base}/api/captures/999999/content/html`)).status).toBe(404);
    expect((await fetch(`${base}/api/captures/${canonicalId}/content/wacz`)).status).toBe(404);
  }, 30_000);
});

function addCapture(db: ReturnType<typeof openDatabase>, source: string, title: string, body: Buffer, mode: 'article' | 'full_page'): number {
  const url = getOrCreateUrl(db, source, source);
  return insertCapture(db, {
    url_id: url.id, source_url: source, final_url: source,
    html: body, compression: 'none', content_hash: createHash('sha256').update(body).digest('hex'), html_size: body.byteLength,
    title, author: null, site_name: 'API fixtures', published_at: null, excerpt: null, lang: 'en',
    extracted_text: `${title} searchable body text`, mode, status: 'succeeded', capture_tool: 'test/api', warnings: null,
  });
}

async function exited(process: Subprocess): Promise<boolean> {
  return Promise.race([process.exited.then(() => true), Bun.sleep(1).then(() => false)]);
}

async function readStderr(process: Subprocess): Promise<string> {
  return process.stderr instanceof ReadableStream
    ? new Response(process.stderr).text()
    : '';
}
