/**
 * bun-packrat — Phase 1 integration test
 * Tests the full pipeline path without a real browser (unit-level proof).
 * Playwright capture tests are run separately (requires browser binary).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, getCaptureById, searchCaptures } from '../src/db/index.js';
import { extractContent, recoverSemanticArticleImages } from '../src/capture/extract.js';
import { sanitizeHtml } from '../src/capture/sanitize.js';
import { assembleHtml } from '../src/capture/assemble.js';
import { normaliseUrl } from '../src/capture/url.js';
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { getOrCreateUrl, insertCapture } from '../src/db/index.js';
import { formatImageRecoveryWarning, waitForCaptureReadiness } from '../src/capture/pipeline.js';

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

describe('capture readiness', () => {
  test('treats networkidle timeout as a warning after DOM content loaded', async () => {
    let received: { state?: string; timeout?: number } = {};
    const warning = await waitForCaptureReadiness({
      waitForLoadState: async (state: string, options: { timeout: number }) => {
        received = { state, timeout: options.timeout };
        throw new Error('timeout');
      },
    }, 'networkidle', 60_000);
    expect(received).toEqual({ state: 'networkidle', timeout: 10_000 });
    expect(warning).toContain('continued after DOM content loaded');
  });

  test('skips redundant readiness waits and accepts successful load state', async () => {
    let calls = 0;
    const page = { waitForLoadState: async () => { calls++; } };
    expect(await waitForCaptureReadiness(page, 'domcontentloaded', 60_000)).toBeNull();
    expect(calls).toBe(0);
    expect(await waitForCaptureReadiness(page, 'load', 60_000)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe('Phase 1 pipeline proof', () => {
  test('extractContent returns article mode for a well-structured article', () => {
    const result = extractContent(SAMPLE_ARTICLE_HTML, 'https://news.example.com/article');
    // Readability should succeed on this article
    expect(result.mode === 'article' || result.mode === 'full_page').toBe(true);
    expect(result.title).toBeTruthy();
    expect(result.extractedText).toBeTruthy();
  });

  test('retains code inside extraction-hostile syntax-highlighter wrappers', () => {
    const intro = '<p>Detailed system administration instructions and explanatory context for readers.</p>'.repeat(6);
    const raw = `<html><head><title>Router guide</title></head><body><div class="post-content">${intro}<h2>Example configuration</h2><div class="highlight"><div id="example-config" class="code-toolbar language-ini"><pre><code class="language-ini">[Match]\nName=eth0\n\n[Network]\nDHCP=yes</code></pre><div class="toolbar"><button>Copy</button></div></div></div></div></body></html>`;
    const extracted = extractContent(raw, 'https://example.com/router');
    expect(extracted.mode).toBe('article');
    expect(extracted.articleHtml).toContain('<pre>');
    expect(extracted.articleHtml).toContain('[Match]');
    expect(extracted.articleHtml).toContain('id="example-config"');
    expect(extracted.articleHtml?.match(/<pre\b/g)).toHaveLength(1);
    expect(extracted.extractionWarnings).toEqual([]);
  });

  test('leaves ordinary and generic widget code wrappers to Readability', () => {
    const intro = '<p>Detailed system administration instructions and explanatory context for readers.</p>'.repeat(6);
    const sample = Array.from({ length:10 }, (_, index) => `option${index}=value${index}`).join('\n');
    for (const className of ['example', 'widget', 'tools']) {
      const raw = `<html><head><title>Router guide</title></head><body><article>${intro}<div class="${className}"><pre><code>${sample}</code></pre></div></article></body></html>`;
      const extracted = extractContent(raw, 'https://example.com/router');
      expect(extracted.extractionWarnings).toEqual([]);
    }
  });

  test('warns when a protected block is lost even if an unrelated pre survives', () => {
    const intro = '<p>Detailed system administration instructions and explanatory context for readers.</p>'.repeat(10);
    const raw = `<html><head><title>Router guide</title></head><body><article>${intro}<pre><code>ordinary=survives</code></pre><aside><div class="code-toolbar"><pre><code>protected=is-dropped</code></pre></div></aside></article></body></html>`;
    const extracted = extractContent(raw, 'https://example.com/router');
    expect(extracted.articleHtml).toContain('ordinary=survives');
    expect(extracted.articleHtml).not.toContain('protected=is-dropped');
    expect(extracted.extractionWarnings).toEqual([
      'Readability retained 0 of 1 code blocks protected from extraction-hostile wrappers',
    ]);
  });

  test('recovers images from a text-matched semantic article when Readability omits them', () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} contains substantial renewable energy reporting and technical context for readers.</p>`).join('');
    const raw = `<html><body><nav>Navigation chrome</nav><main><article id="story">${paragraphs}<figure><img src="https://images.example.com/a.jpg" alt="A"></figure><figure><img src="https://images.example.com/b.jpg" alt="B"></figure></article></main></body></html>`;
    const readabilityText = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} contains substantial renewable energy reporting and technical context for readers.`).join(' ');
    const recovered = recoverSemanticArticleImages(raw, `<div>${paragraphs}</div>`, readabilityText);
    expect(recovered.imageRecovery).toEqual({ readabilityImages: 0, recoveredImages: 2 });
    expect(recovered.articleHtml).toContain('id="story"');
    expect(recovered.articleHtml?.match(/<img\b/g)).toHaveLength(2);
  });

  test('prefers a matching nested article over an ancestor main with unrelated images', () => {
    const paragraphs = '<p>Substantial reporting about energy systems and storage capacity for technical readers.</p>'.repeat(8);
    const raw = `<main><img src="chrome-a.jpg"><img src="chrome-b.jpg"><article id="story">${paragraphs}<img src="article-a.jpg"><img src="article-b.jpg"></article><img src="teaser.jpg"></main>`;
    const recovered = recoverSemanticArticleImages(raw, `<div>${paragraphs}</div>`, paragraphs.replace(/<[^>]+>/g, ' '));
    expect(recovered.imageRecovery).toEqual({ readabilityImages:0, recoveredImages:2 });
    expect(recovered.articleHtml).toContain('id="story"');
    expect(recovered.articleHtml).not.toContain('chrome-a.jpg');
    expect(recovered.articleHtml).not.toContain('teaser.jpg');
  });

  test('does not replace Readability output with a textually unrelated image container', () => {
    const article = `<article>${'<p>Carefully extracted reporting about energy systems and storage capacity.</p>'.repeat(8)}</article>`;
    const gallery = `<main>${'<p>Product cards and unrelated navigation labels.</p>'.repeat(8)}<img src="a.jpg"><img src="b.jpg"></main>`;
    const recovered = recoverSemanticArticleImages(`<html><body>${article}${gallery}</body></html>`, article, article.replace(/<[^>]+>/g, ' '));
    expect(recovered.imageRecovery).toBeNull();
    expect(recovered.articleHtml).toBe(article);
  });

  test('image recovery warning reports images retained after sanitisation', () => {
    const warning = formatImageRecoveryWarning(0, '<article><img src="data:image/png;base64,AA=="><p>Body</p><img src="data:image/png;base64,AA=="></article>');
    expect(warning).toBe('Readability omitted article images; recovered semantic article container (0 → 2 images retained)');
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
    expect(result).toContain('name="packrat:author" content="Jane Smith"');
    expect(result).toContain('Test Article');
    expect(result).toContain('This is the article body.');
    expect(result).toContain('.packrat-header code { overflow-wrap: anywhere; word-break: break-all; }');
    expect(result).toContain('.packrat-content :not(pre) > code { overflow-wrap: anywhere; word-break: break-word; }');
    expect(result).toContain('.packrat-content pre {\n  max-width: 100%;');
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
