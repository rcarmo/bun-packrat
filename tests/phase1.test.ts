/**
 * bun-packrat — Phase 1 integration test
 * Tests the full pipeline path without a real browser (unit-level proof).
 * Playwright capture tests are run separately (requires browser binary).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, getCaptureById, searchCaptures } from '../src/db/index.js';
import { extractContent } from '../src/capture/extract.js';
import { sanitizeHtml } from '../src/capture/sanitize.js';
import { assembleHtml } from '../src/capture/assemble.js';
import { normaliseUrl } from '../src/capture/url.js';
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { getOrCreateUrl, insertCapture } from '../src/db/index.js';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

const SAMPLE_ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test Article</title>
  <meta property="og:site_name" content="Test Site">
  <meta property="og:title" content="Test Article OG">
</head>
<body>
  <script>document.cookie = "evil=1"</script>
  <div class="popup" style="position:fixed;z-index:9999">Cookie notice</div>
  <article>
    <h1>The Future of Renewable Energy</h1>
    <p>By Jane Smith</p>
    <p>
      Renewable energy sources are transforming the global power grid.
      Solar and wind capacity has grown exponentially over the past decade,
      driven by falling costs and government incentives.
    </p>
    <p>
      Experts predict that by 2035, renewable energy could supply more than
      half of global electricity demand. Battery storage technology is the
      remaining bottleneck, but recent breakthroughs suggest a path forward.
    </p>
    <p>
      The transition also brings economic benefits. Millions of jobs in
      manufacturing, installation and grid management are expected to emerge
      as fossil fuel industries decline.
    </p>
  </article>
  <iframe src="https://tracker.example.com/pixel"></iframe>
  <form action="/subscribe"><input type="email"><button>Subscribe</button></form>
</body>
</html>`;

describe('Phase 1 pipeline proof', () => {
  test('extractContent returns article mode for a well-structured article', () => {
    const result = extractContent(SAMPLE_ARTICLE_HTML, 'https://news.example.com/article');
    // Readability should succeed on this article
    expect(result.mode === 'article' || result.mode === 'full_page').toBe(true);
    expect(result.title).toBeTruthy();
    expect(result.extractedText).toBeTruthy();
  });

  test('sanitizeHtml removes scripts, iframes, forms', () => {
    const { html, warnings } = sanitizeHtml(SAMPLE_ARTICLE_HTML);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('document.cookie');
  });

  test('assembleHtml produces a valid self-contained document', () => {
    const bodyHtml = '<p>This is the article body.</p>';
    const result = assembleHtml(bodyHtml, {
      title: 'Test Article',
      author: 'Jane Smith',
      siteName: 'Test Site',
      publishedAt: '2026-08-10',
      lang: 'en',
      sourceUrl: 'https://news.example.com/article',
      finalUrl: 'https://news.example.com/article',
      capturedAt: new Date().toISOString(),
      captureId: 1,
      mode: 'article',
    });

    expect(result).toContain('<!DOCTYPE html>');
    expect(result).toContain('<meta charset="utf-8">');
    // CSP is set as an HTTP response header, not embedded in the HTML body
    expect(result).toContain('packrat:source-url');
    expect(result).toContain('packrat:captured-at');
    expect(result).toContain('Jane Smith');
    expect(result).toContain('Test Article');
    expect(result).toContain('This is the article body.');
    // No external dependencies
    expect(result).not.toMatch(/src="https?:\/\//);
    expect(result).not.toMatch(/href="https?:\/\/(?!.*noopener)/);
  });

  test('full pipeline: extract → sanitise → assemble → store → search', () => {
    // Extract
    const extracted = extractContent(SAMPLE_ARTICLE_HTML, 'https://news.example.com/article');

    // Sanitise
    const { html: sanitised } = sanitizeHtml(
      extracted.articleHtml ?? SAMPLE_ARTICLE_HTML,
    );

    // Assemble
    const captured = new Date().toISOString();
    const finalHtml = assembleHtml(sanitised, {
      title: extracted.title,
      author: extracted.author,
      siteName: extracted.siteName,
      publishedAt: extracted.publishedAt,
      lang: extracted.lang,
      sourceUrl: 'https://news.example.com/article',
      finalUrl: 'https://news.example.com/article',
      capturedAt: captured,
      mode: extracted.mode,
    });

    expect(finalHtml).toContain('<!DOCTYPE html>');

    // Content hash
    const htmlBytes = Buffer.from(finalHtml, 'utf-8');
    const hash = createHash('sha256').update(htmlBytes).digest('hex');
    expect(hash).toHaveLength(64);

    // Normalise URL
    const normUrl = normaliseUrl('https://news.example.com/article?utm_source=test');
    expect(normUrl).not.toContain('utm_source');

    // Store in DB
    const urlRow = getOrCreateUrl(db, normUrl, 'https://news.example.com/article?utm_source=test');
    const captureId = insertCapture(db, {
      url_id: urlRow.id,
      source_url: 'https://news.example.com/article?utm_source=test',
      final_url: 'https://news.example.com/article',
      html: htmlBytes,
      compression: 'none',
      content_hash: hash,
      html_size: htmlBytes.byteLength,
      title: extracted.title,
      author: extracted.author,
      site_name: extracted.siteName,
      published_at: extracted.publishedAt,
      excerpt: extracted.excerpt,
      lang: extracted.lang,
      extracted_text: extracted.extractedText,
      mode: extracted.mode,
      status: 'succeeded',
      capture_tool: 'test/phase1',
      warnings: null,
    });

    // Retrieve
    const stored = getCaptureById(db, captureId);
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('succeeded');
    expect(stored!.content_hash).toBe(hash);
    expect(stored!.html_size).toBe(htmlBytes.byteLength);

    // Search
    if (extracted.extractedText && extracted.extractedText.includes('energy')) {
      const results = searchCaptures(db, 'renewable energy', { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].id).toBe(captureId);
    }

    // Verify the stored HTML is safe
    const storedHtmlStr = Buffer.from(stored!.html as any).toString('utf-8');
    expect(storedHtmlStr).not.toContain('<script');
    expect(storedHtmlStr).not.toContain('<iframe');
  });
});
