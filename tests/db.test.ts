/**
 * bun-packrat — database unit tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture, getCaptureById, getCaptureHtml, listCaptures, searchCaptures, updateLatestCapture, findRecentCapture, addCaptureAlias, getCaptureAliases, updateCaptureNote, attachSourcePdf, getSourcePdfBytes, getSourcePdfMetadata, getSourcePdfRange } from '../src/db/index.js';
import type { Database } from 'bun:sqlite';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('schema migrations', () => {
  test('applies migration 001 without error', () => {
    const row = db
      .query<{ version: number }, []>('SELECT version FROM schema_migrations')
      .get();
    expect(row?.version).toBe(1);
    const latest = db.query<{ version: number }, []>('SELECT MAX(version) version FROM schema_migrations').get();
    expect(latest?.version).toBe(7);
  });

  test('creates all required tables', () => {
    const tables = db
      .query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `)
      .all()
      .map((r) => r.name);

    expect(tables).toContain('captures');
    expect(tables).toContain('urls');
    expect(tables).toContain('capture_aliases');
    expect(tables).toContain('metadata');
    expect(tables).toContain('tags');
    expect(tables).toContain('capture_tags');
    expect(tables).toContain('jobs');
    expect(tables).toContain('attempts');
    expect(tables).toContain('archivebox_imports');
    expect(tables).toContain('schema_migrations');
    expect(tables).toContain('pdf_blobs');
    expect(tables).toContain('capture_pdfs');
    expect(tables).toContain('pdf_extractions');
    expect(tables).toContain('archivebox_pdf_enrichment');
    expect(tables).toContain('capture_storage_migrations');
  });

  test('creates captures_fts virtual table', () => {
    const fts = db
      .query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='captures_fts'
      `)
      .get();
    expect(fts?.name).toBe('captures_fts');
  });

  test('is idempotent — running twice does not error', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('getOrCreateUrl', () => {
  test('creates a new URL row', () => {
    const row = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    expect(row.id).toBeGreaterThan(0);
    expect(row.normalised).toBe('https://example.com/');
    expect(row.domain).toBe('example.com');
  });

  test('returns existing row on second call', () => {
    const a = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const b = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    expect(a.id).toBe(b.id);
  });

  test('strips www from domain', () => {
    const row = getOrCreateUrl(db, 'https://www.example.com/', 'https://www.example.com/');
    expect(row.domain).toBe('example.com');
  });
});

describe('insertCapture', () => {
  test('inserts a capture and returns an id', () => {
    const url = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const id = insertCapture(db, {
      url_id: url.id,
      source_url: 'https://example.com/',
      final_url: 'https://example.com/',
      html: null,
      compression: 'none',
      content_hash: null,
      html_size: null,
      title: 'Example',
      author: null,
      site_name: null,
      published_at: null,
      excerpt: null,
      lang: null,
      extracted_text: null,
      mode: 'article',
      status: 'pending',
      capture_tool: 'test/0',
      warnings: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  test('retrieves the inserted capture', () => {
    const url = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const id = insertCapture(db, {
      url_id: url.id,
      source_url: 'https://example.com/',
      final_url: 'https://example.com/',
      html: Buffer.from('<html></html>', 'utf-8'),
      compression: 'none',
      content_hash: 'abc123',
      html_size: 13,
      title: 'Test Page',
      author: 'Test Author',
      site_name: 'Test Site',
      published_at: null,
      excerpt: 'A test excerpt',
      lang: 'en',
      extracted_text: 'full text here',
      mode: 'article',
      status: 'succeeded',
      capture_tool: 'test/0',
      warnings: null,
    });

    const c = getCaptureById(db, id);
    expect(c).not.toBeNull();
    expect(c!.title).toBe('Test Page');
    expect(c!.status).toBe('succeeded');
    expect(c!.mode).toBe('article');
    expect(c!.body_format).toBe('html');
    expect(Object.hasOwn(c!, 'html')).toBe(false);
    expect(Object.hasOwn(c!, 'extracted_text')).toBe(false);
    expect(Buffer.from(getCaptureHtml(db, id)!.html! as Uint8Array).toString('utf8')).toBe('<html></html>');
  });

  test('keeps list and search rows free of canonical bodies and extracted text', () => {
    const url = getOrCreateUrl(db, 'https://large.example.com/', 'https://large.example.com/');
    insertCapture(db, {
      url_id: url.id, source_url: url.original, final_url: url.original,
      html: Buffer.from(`<!doctype html><html><body>${'A'.repeat(1024 * 1024)}</body></html>`), compression: 'none', content_hash: 'large', html_size: 1024 * 1024,
      title: 'Large searchable capture', author: null, site_name: null, published_at: null,
      excerpt: null, lang: null, extracted_text: 'large searchable body', mode: 'article',
      status: 'succeeded', capture_tool: 'test/0', warnings: null,
    });
    for (const row of [...listCaptures(db), ...searchCaptures(db, 'searchable')]) {
      expect(Object.hasOwn(row, 'html')).toBe(false);
      expect(Object.hasOwn(row, 'extracted_text')).toBe(false);
    }
  });

  test('resumes canonical body-format backfill after migration 5 is recorded', () => {
    const url = getOrCreateUrl(db, 'https://legacy.example.com/', 'https://legacy.example.com/');
    const legacyBody = Buffer.from('From: <Saved by Blink>\r\nContent-Type: multipart/related; boundary=x\r\n');
    const id = insertCapture(db, {
      url_id: url.id, source_url: url.original, final_url: url.original,
      html: legacyBody,
      compression: 'none', content_hash: 'legacy', html_size: legacyBody.byteLength, title: 'Legacy', author: null,
      site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null,
      mode: 'full_page', status: 'succeeded', capture_tool: 'test/0', warnings: null,
    });
    db.exec('UPDATE captures SET body_format=NULL WHERE id=?', [id]);
    expect(getCaptureById(db, id)?.body_format).toBeNull();
    runMigrations(db);
    expect(getCaptureById(db, id)?.body_format).toBe('mhtml');
  });
});

describe('source PDF storage', () => {
  function capture(title: string): number {
    const url = getOrCreateUrl(db, `https://${title.toLowerCase()}.example.com/`, `https://${title.toLowerCase()}.example.com/`);
    return insertCapture(db, {
      url_id: url.id, source_url: url.original, final_url: url.original,
      html: null, compression: 'none', content_hash: null, html_size: null,
      title, author: null, site_name: null, published_at: null, excerpt: null,
      lang: null, extracted_text: title, mode: 'metadata_only', status: 'succeeded',
      capture_tool: 'test/0', warnings: null,
    });
  }

  test('validates, deduplicates, and reads source PDFs by bounded byte range', () => {
    const first = capture('First');
    const second = capture('Second');
    const pdf = Buffer.from('%PDF-1.7\nbyte-exact-source-pdf\n%%EOF\n');
    const one = attachSourcePdf(db, { captureId: first, bytes: pdf, sourceKind: 'direct', sourceMime: 'application/pdf' });
    const two = attachSourcePdf(db, { captureId: second, bytes: pdf, sourceKind: 'archivebox_original', sourceLocator: 'archive/1/output.pdf' });
    expect(one.sha256).toBe(two.sha256);
    expect(one.pdf_blob_id).toBe(two.pdf_blob_id);
    expect(db.query<{ n:number },[]>('SELECT count(*) n FROM pdf_blobs').get()?.n).toBe(1);
    expect(Buffer.from(getSourcePdfBytes(db, first)!)).toEqual(pdf);
    expect(Buffer.from(getSourcePdfRange(db, first, 5, 11)!).toString('utf8')).toBe('1.7\nbyt');
    expect(getSourcePdfMetadata(db, first)?.extraction_status).toBe('pending');
    expect(getCaptureById(db, first)?.source_pdf_size).toBe(pdf.byteLength);
    expect(Object.hasOwn(getCaptureById(db, first)!, 'bytes')).toBe(false);
  });

  test('rejects non-PDF bytes and invalid ranges', () => {
    const id = capture('Invalid');
    expect(() => attachSourcePdf(db, { captureId: id, bytes: Buffer.from('not pdf'), sourceKind: 'direct' })).toThrow('%PDF-');
    expect(() => getSourcePdfRange(db, id, -1, 2)).toThrow('Invalid PDF byte range');
  });

  test('removes the prior orphaned blob when one capture is reattached', () => {
    const id = capture('Reattached');
    const first = Buffer.from('%PDF-1.4\nfirst\n%%EOF');
    const second = Buffer.from('%PDF-1.4\nsecond\n%%EOF');
    attachSourcePdf(db, { captureId:id,bytes:first,sourceKind:'direct' });
    attachSourcePdf(db, { captureId:id,bytes:second,sourceKind:'direct' });
    expect(db.query<{ n:number },[]>('SELECT count(*) n FROM pdf_blobs').get()?.n).toBe(1);
    expect(Buffer.from(getSourcePdfBytes(db, id)!).equals(second)).toBe(true);
  });

  test('removes an orphaned PDF blob only after its last capture is deleted', () => {
    const first = capture('SharedOne');
    const second = capture('SharedTwo');
    const pdf = Buffer.from('%PDF-1.4\nshared\n%%EOF');
    attachSourcePdf(db, { captureId: first, bytes: pdf, sourceKind: 'direct' });
    attachSourcePdf(db, { captureId: second, bytes: pdf, sourceKind: 'direct' });
    db.exec('DELETE FROM captures WHERE id=?', [first]);
    expect(db.query<{ n:number },[]>('SELECT count(*) n FROM pdf_blobs').get()?.n).toBe(1);
    db.exec('DELETE FROM captures WHERE id=?', [second]);
    expect(db.query<{ n:number },[]>('SELECT count(*) n FROM pdf_blobs').get()?.n).toBe(0);
  });
});

describe('FTS search', () => {
  test('indexes a capture and finds it by title', () => {
    const url = getOrCreateUrl(db, 'https://news.example.com/article', 'https://news.example.com/article');
    insertCapture(db, {
      url_id: url.id,
      source_url: 'https://news.example.com/article',
      final_url: 'https://news.example.com/article',
      html: null,
      compression: 'none',
      content_hash: null,
      html_size: null,
      title: 'Quantum computing breakthrough',
      author: 'Jane Doe',
      site_name: 'Example News',
      published_at: null,
      excerpt: null,
      lang: 'en',
      extracted_text: 'Scientists announce a major leap in quantum computing research.',
      mode: 'article',
      status: 'succeeded',
      capture_tool: 'test/0',
      warnings: null,
    });

    const results = searchCaptures(db, 'quantum computing', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Quantum computing breakthrough');
  });

  test('returns empty results for unmatched query', () => {
    const results = searchCaptures(db, 'xyzzy_does_not_exist_42', { limit: 10 });
    expect(results.length).toBe(0);
  });
});

describe('capture application features', () => {
  test('finds a recent successful capture for freshness reuse', () => {
    const url = getOrCreateUrl(db, 'https://recent.example.com/', 'https://recent.example.com/');
    const id = insertCapture(db, { url_id: url.id, source_url: url.original, final_url: url.original, html: null, compression: 'none', content_hash: 'x', html_size: 1, title: 'Recent', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: 'recent', mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null });
    updateLatestCapture(db, url.id, id);
    expect(findRecentCapture(db, url.normalised, 3600)?.id).toBe(id);
    expect(findRecentCapture(db, url.normalised, 0)).toBeNull();
  });

  test('stores aliases and notes', () => {
    const url = getOrCreateUrl(db, 'https://alias.example.com/', 'https://alias.example.com/');
    const id = insertCapture(db, { url_id: url.id, source_url: url.original, final_url: url.original, html: null, compression: 'none', content_hash: null, html_size: null, title: 'Alias', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null });
    addCaptureAlias(db, id, 'https://alias.example.com/old', 'redirect');
    updateCaptureNote(db, id, 'Remember this');
    expect(getCaptureAliases(db, id)).toEqual([{ url: 'https://alias.example.com/old', kind: 'redirect' }]);
    expect(getCaptureById(db, id)?.note).toBe('Remember this');
  });
});

describe('listCaptures', () => {
  test('returns only succeeded captures', () => {
    const url = getOrCreateUrl(db, 'https://a.example.com/', 'https://a.example.com/');
    insertCapture(db, { url_id: url.id, source_url: 'https://a.example.com/', final_url: 'https://a.example.com/', html: null, compression: 'none', content_hash: null, html_size: null, title: 'A', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null });
    insertCapture(db, { url_id: url.id, source_url: 'https://a.example.com/', final_url: 'https://a.example.com/', html: null, compression: 'none', content_hash: null, html_size: null, title: 'B', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'article', status: 'failed', capture_tool: 'test/0', warnings: null });

    const rows = listCaptures(db, { status: 'succeeded' });
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
  });

  test('filters by domain, title, mode, and status', () => {
    const url = getOrCreateUrl(db, 'https://filters.example.com/a', 'https://filters.example.com/a');
    insertCapture(db, { url_id: url.id, source_url: url.original, final_url: url.original, html: null, compression: 'none', content_hash: null, html_size: null, title: 'Specific title', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'full_page', status: 'failed', capture_tool: 'test/0', warnings: null });
    const rows = listCaptures(db, { domain: 'filters.example.com', title: 'specific', mode: 'full_page', status: 'failed' });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Specific title');
  });
});
