import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Subprocess } from 'bun';
import { getOrCreateUrl, insertCapture, openDatabase, runMigrations } from '../src/db/index.js';

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'packrat-api-test-'));
  dbPath = join(dir, 'packrat.sqlite');
  const db = openDatabase(dbPath);
  runMigrations(db);
  canonicalId = addCapture(db, 'https://example.com/canonical', 'Canonical API fixture', Buffer.from(MHTML), 'full_page');
  legacyId = addCapture(db, 'https://legacy.example.com/article', 'Legacy API fixture', Buffer.from(LEGACY_HTML), 'article');
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
