/**
 * bun-packrat — EPUB export tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture } from '../src/db/index.js';
import { exportEpub } from '../src/export/epub.js';
import type { Database } from 'bun:sqlite';

let db: Database;

const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<title>EPUB Test Article</title>
<meta name="packrat:source-url" content="https://example.com/epub-test">
<meta name="packrat:captured-at" content="2026-08-10T12:00:00Z">
</head>
<body>
<div class="packrat-header">
  <span>Archived 2026-08-10</span>
</div>
<div class="packrat-content">
<h1>EPUB Test Article</h1>
<p>By <strong>Jane Smith</strong></p>
<p>This is the first paragraph of the article with some content to verify.</p>
<p>Second paragraph with more text for the EPUB body.</p>
<img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==" alt="cover">
<figure><img src="data:image/avif;base64,AAAA" alt="unsupported"><figcaption>Unsupported AVIF caption</figcaption></figure>
<img alt="missing source"><figcaption>Orphan caption</figcaption>
<picture><source srcset="data:image/avif;base64,AAAA"></picture>
<p><a href="https://example.com/share?utm_source=test&utm_medium=email">Tracked link</a></p>
<ul><li>List item one</li><li>List item two</li></ul>
</div>
</body>
</html>`;

function insertTestCapture(db: Database): number {
  const url = getOrCreateUrl(db, 'https://example.com/epub-test', 'https://example.com/epub-test');
  const htmlBytes = Buffer.from(SAMPLE_HTML, 'utf-8');
  return insertCapture(db, {
    url_id: url.id, source_url: 'https://example.com/epub-test',
    final_url: 'https://example.com/epub-test', html: htmlBytes, compression: 'none',
    content_hash: 'abc', html_size: htmlBytes.byteLength,
    title: 'EPUB Test Article', author: 'Jane Smith', site_name: 'Example',
    published_at: '2026-08-10', excerpt: 'First paragraph', lang: 'en',
    extracted_text: 'This is the first paragraph.',
    mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null,
  });
}

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('exportEpub', () => {
  test('returns null for non-existent capture', async () => {
    expect(await exportEpub(db, 9999)).toBeNull();
  });

  test('returns an EPUB Uint8Array', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();
    expect(r!.epub).toBeInstanceOf(Uint8Array);
    expect(r!.epub.length).toBeGreaterThan(200);
    expect(r!.filename).toMatch(/\.epub$/);
  });

  test('EPUB starts with ZIP PK signature', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();
    expect(r!.epub[0]).toBe(0x50);
    expect(r!.epub[1]).toBe(0x4b);
  });

  test('EPUB ZIP contains required EPUB 3 files', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();

    // Check by scanning the ZIP for known filenames
    const content = Buffer.from(r!.epub).toString('latin1');
    expect(content).toContain('mimetype');
    expect(content).toContain('META-INF/container.xml');
    expect(content).toContain('OEBPS/content.opf');
    expect(content).toContain('OEBPS/nav.xhtml');
    expect(content).toContain('OEBPS/article.xhtml');
  });

  test('EPUB mimetype entry starts at offset 0 (EPUB spec requirement)', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();

    // The first ZIP local file header must be 'mimetype'
    const buf = Buffer.from(r!.epub);
    // Skip 30-byte local header to read the filename
    const nameLen = buf.readUInt16LE(26);
    const filename = buf.slice(30, 30 + nameLen).toString('ascii');
    expect(filename).toBe('mimetype');

    // The content of mimetype must be exactly "application/epub+zip"
    const dataStart = 30 + nameLen;
    const dataSize = buf.readUInt32LE(22);
    const mimeContent = buf.slice(dataStart, dataStart + dataSize).toString('ascii');
    expect(mimeContent).toBe('application/epub+zip');
  });

  test('content.opf contains EPUB 3.0 package element', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();

    const content = Buffer.from(r!.epub).toString('latin1');
    expect(content).toContain('version="3.0"');
    expect(content).toContain('EPUB Test Article');
    expect(content).toContain('properties="cover-image"');
    expect(content).toContain('<meta name="cover" content="img0" />');
    expect(content).toContain('<dc:date>');
    expect(content).not.toContain('image/avif');
    expect(content).not.toContain('Orphan caption');
    expect(content).not.toContain('<picture>');
    expect(content).toContain('utm_source=test&amp;utm_medium=email');
  });

  test('passes installed epubcheck release validator', async () => {
    if (!Bun.which('epubcheck')) return;
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    const dir = mkdtempSync(join(tmpdir(), 'packrat-epubcheck-'));
    const path = join(dir, 'test.epub');
    try {
      await Bun.write(path, r!.epub);
      const proc = Bun.spawnSync(['epubcheck', path], { stdout: 'pipe', stderr: 'pipe' });
      expect(proc.exitCode, `${proc.stdout.toString()}\n${proc.stderr.toString()}`).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  test('archive header div is removed from EPUB article body', async () => {
    const id = insertTestCapture(db);
    const r = await exportEpub(db, id);
    expect(r).not.toBeNull();

    const content = Buffer.from(r!.epub).toString('utf-8');
    // The packrat-header should not appear in the EPUB article
    expect(content).not.toContain('packrat-header');
    expect(content).toContain('EPUB Test Article');
  });
});
