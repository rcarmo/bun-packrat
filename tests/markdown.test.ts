/**
 * bun-packrat — Markdown export tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture } from '../src/db/index.js';
import { exportMarkdownZip, htmlToMarkdown } from '../src/export/markdown.js';
import type { Database } from 'bun:sqlite';

let db: Database;

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Article</title></head>
<body>
<h1>Test Article</h1>
<p>First paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
<h2>Section Two</h2>
<p>A <a href="https://example.com">link</a> and some <code>inline code</code>.</p>
<pre><code class="language-js">const x = 1;</code></pre>
<ul>
  <li>Item one</li>
  <li>Item two</li>
</ul>
<blockquote>A quoted passage.</blockquote>
<table>
  <thead><tr><th>Name</th><th>Value</th></tr></thead>
  <tbody><tr><td>foo</td><td>42</td></tr></tbody>
</table>
</body>
</html>`;

function insertTestCapture(db: Database, html: string): number {
  const url = getOrCreateUrl(db, 'https://example.com/article', 'https://example.com/article');
  const htmlBytes = Buffer.from(html, 'utf-8');
  return insertCapture(db, {
    url_id: url.id,
    source_url: 'https://example.com/article',
    final_url: 'https://example.com/article',
    html: htmlBytes,
    compression: 'none',
    content_hash: 'abc',
    html_size: htmlBytes.byteLength,
    title: 'Test Article',
    author: 'Jane Smith',
    site_name: 'Example Site',
    published_at: '2026-08-10',
    excerpt: 'First paragraph',
    lang: 'en',
    extracted_text: 'First paragraph with bold and italic text.',
    mode: 'article',
    status: 'succeeded',
    capture_tool: 'test/0',
    warnings: null,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('Markdown table generation', () => {
  test('resolves legacy relative links and emits linked images without malformed nesting', () => {
    const result = htmlToMarkdown(`<!doctype html><html><body><div class="packrat-content">
      <p><a href="/about">About us</a></p>
      <figure><a href="/uploads/full.webp"><img src="data:image/webp;base64,AAAA" alt="Board photo"></a></figure>
    </div></body></html>`, { baseUrl:'https://example.com/posts/item' });
    expect(result.markdown).toContain('[About us](https://example.com/about)');
    expect(result.markdown).toContain('![Board photo](https://example.com/uploads/full.webp)');
    expect(result.markdown).not.toContain('[![');
    expect(result.markdown).not.toContain('*[Image:');
  });

  test('escapes literal pipes and flattens cell line breaks', () => {
    const result = htmlToMarkdown('<html><body><table><tr><th>Name</th><th>Notes</th></tr><tr><td>A | B</td><td>First<br>Second</td></tr></table></body></html>');
    expect(result.markdown).toContain('| A \\| B | FirstSecond |');
    expect(result.markdown).toContain('| --- | --- |');
  });
});

describe('exportMarkdownZip', () => {
  test('returns null for non-existent capture', async () => {
    const r = await exportMarkdownZip(db, 9999);
    expect(r).toBeNull();
  });

  test('returns a ZIP for a succeeded capture', async () => {
    const id = insertTestCapture(db, SAMPLE_HTML);
    const r = await exportMarkdownZip(db, id);
    expect(r).not.toBeNull();
    expect(r!.zip).toBeInstanceOf(Uint8Array);
    expect(r!.zip.length).toBeGreaterThan(100);
    expect(r!.filename).toMatch(/\.zip$/);
  });

  test('ZIP starts with PK signature', async () => {
    const id = insertTestCapture(db, SAMPLE_HTML);
    const r = await exportMarkdownZip(db, id);
    expect(r).not.toBeNull();
    // ZIP magic bytes: 50 4B 03 04
    expect(r!.zip[0]).toBe(0x50);
    expect(r!.zip[1]).toBe(0x4b);
  });

  test('returns null for pending (not succeeded) capture', async () => {
    const url = getOrCreateUrl(db, 'https://example.com/pending', 'https://example.com/pending');
    insertCapture(db, {
      url_id: url.id, source_url: 'https://example.com/pending',
      final_url: 'https://example.com/pending', html: null, compression: 'none',
      content_hash: null, html_size: null, title: null, author: null, site_name: null,
      published_at: null, excerpt: null, lang: null, extracted_text: null,
      mode: 'article', status: 'pending', capture_tool: 'test/0', warnings: null,
    });
    const id = db.query<{ id: number }, []>('SELECT id FROM captures WHERE status="pending" LIMIT 1').get()!.id;
    const r = await exportMarkdownZip(db, id);
    expect(r).toBeNull();
  });

  test('data: URL images are extracted to assets/', async () => {
    // 1x1 transparent PNG as data: URL
    const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const htmlWithImg = `<html><body><h1>Img Test</h1><p>Text</p><img src="data:image/png;base64,${pngB64}" alt="test"></body></html>`;
    const id = insertTestCapture(db, htmlWithImg);
    const r = await exportMarkdownZip(db, id);
    expect(r).not.toBeNull();
    // ZIP content should reference assets/img-0.png
    const zipStr = Buffer.from(r!.zip).toString('latin1');
    expect(zipStr).toContain('assets/img-0.png');
    expect(zipStr).toContain('article.md');
    expect(zipStr).toContain('metadata.json');
  });
});
