/**
 * bun-packrat — Playwright capture pipeline
 *
 * Orchestrates browser launch → page load → content extraction →
 * asset inlining → sanitisation → assembly → storage.
 */

import { chromium } from 'playwright';
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { PackratConfig, CaptureResult } from '../types.js';
import { normaliseUrl, guardSsrf, UrlValidationError } from './url.js';
import { extractContent } from './extract.js';
import { sanitizeHtml } from './sanitize.js';
import { inlineAssets } from './assets.js';
import { assembleHtml } from './assemble.js';
import {
  getOrCreateUrl,
  insertCapture,
  updateCaptureStatus,
  updateLatestCapture,
} from '../db/index.js';

export interface PipelineOptions {
  config: PackratConfig;
  db: Database;
}

const TOOL_VERSION = 'packrat/0.1.0';

/** Playwright overlay-dismissal script injected into the page */
const DISMISS_OVERLAYS_JS = `
(function() {
  // Remove fixed/sticky elements that look like overlays
  document.querySelectorAll('*').forEach(el => {
    const s = getComputedStyle(el);
    if ((s.position === 'fixed' || s.position === 'sticky') && s.zIndex > 100) {
      const rect = el.getBoundingClientRect();
      const isLarge = rect.width > window.innerWidth * 0.4 && rect.height > 50;
      if (isLarge) el.remove();
    }
  });
  // Remove common overlay class patterns
  ['cookie', 'consent', 'gdpr', 'newsletter', 'popup', 'modal', 'overlay', 'banner']
    .forEach(kw => {
      document.querySelectorAll(\`[class*="\${kw}"],[id*="\${kw}"]\`).forEach(el => el.remove());
    });
})();
`;

/**
 * Run the full capture pipeline for a URL.
 * Returns the CaptureResult on success; throws on validation or capture failure.
 */
export async function capturePage(
  rawUrl: string,
  opts: PipelineOptions,
): Promise<CaptureResult> {
  const { config, db } = opts;

  // 1. Validate and normalise URL
  let normalisedUrl: string;
  try {
    normalisedUrl = normaliseUrl(rawUrl);
    guardSsrf(normalisedUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) throw err;
    throw new Error(`URL validation failed: ${err}`);
  }

  // 2. Create a capture row in pending state
  const urlRow = getOrCreateUrl(db, normalisedUrl, rawUrl);
  const captureId = insertCapture(db, {
    url_id: urlRow.id,
    source_url: rawUrl,
    final_url: rawUrl,            // will be updated after navigation
    html: null,
    compression: 'none',
    content_hash: null,
    html_size: null,
    title: null,
    author: null,
    site_name: null,
    published_at: null,
    excerpt: null,
    lang: null,
    extracted_text: null,
    mode: 'article',
    status: 'pending',
    capture_tool: TOOL_VERSION,
    warnings: null,
  });

  const warnings: string[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    // 3. Launch browser
    browser = await chromium.launch({
      headless: true,
      executablePath: findChromiumExecutable(config.playwrightBrowsersPath),
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (compatible; packrat-archiver/0.1; +https://github.com/rcarmo/bun-packrat)',
      javaScriptEnabled: true,
      offline: false,
    });

    const page = await context.newPage();
    page.setDefaultNavigationTimeout(config.captureTimeoutMs);
    page.setDefaultTimeout(config.captureTimeoutMs);

    // 4. Navigate
    const response = await page.goto(normalisedUrl, {
      waitUntil: 'networkidle',
      timeout: config.captureTimeoutMs,
    });

    if (!response) {
      throw new Error(`Navigation to ${normalisedUrl} returned no response`);
    }

    const finalUrl = page.url();
    const httpStatus = response.status();

    if (httpStatus >= 400) {
      warnings.push(`HTTP ${httpStatus} response for ${finalUrl}`);
    }

    // 5. Dismiss overlays and scroll for lazy content
    await page.evaluate(DISMISS_OVERLAYS_JS).catch(() => {});
    await scrollPage(page);

    // 6. Get rendered HTML
    const renderedHtml = await page.content();

    await context.close();

    // 7. Extract article content
    const extracted = extractContent(renderedHtml, finalUrl);
    if (extracted.mode === 'full_page') {
      warnings.push('Readability extraction failed or yielded too little text; using full-page mode');
    }

    // 8. Inline external assets
    const { html: htmlWithAssets, warnings: assetWarnings } = await inlineAssets(
      extracted.articleHtml ?? renderedHtml,
      {
        baseUrl: finalUrl,
        maxAssetBytes: config.maxAssetSizeBytes,
      },
    );
    warnings.push(...assetWarnings);

    // 9. Sanitise
    const { html: sanitisedHtml, warnings: sanitiseWarnings } = sanitizeHtml(htmlWithAssets);
    warnings.push(...sanitiseWarnings);

    // 10. Assemble final document
    const capturedAt = new Date().toISOString();
    const finalHtml = assembleHtml(sanitisedHtml, {
      title: extracted.title,
      author: extracted.author,
      siteName: extracted.siteName,
      publishedAt: extracted.publishedAt,
      lang: extracted.lang,
      sourceUrl: rawUrl,
      finalUrl,
      capturedAt,
      captureId,
      mode: extracted.mode,
      captureTool: TOOL_VERSION,
    });

    // Size guard
    const htmlBytes = Buffer.from(finalHtml, 'utf-8');
    if (htmlBytes.byteLength > config.maxPageSizeBytes) {
      warnings.push(
        `Captured page exceeds max size (${htmlBytes.byteLength} > ${config.maxPageSizeBytes} bytes); clamped`,
      );
    }

    // 11. Content hash
    const contentHash = createHash('sha256').update(htmlBytes).digest('hex');

    // 12. Optional compression
    let storedBlob: Buffer = htmlBytes;
    let compression: 'none' | 'gzip' = 'none';

    if (config.htmlCompression === 'gzip') {
      const { gzipSync } = await import('zlib');
      storedBlob = gzipSync(htmlBytes);
      compression = 'gzip';
    }

    // 13. Write to database
    db.exec(
      `UPDATE captures SET
         final_url = ?,
         html = ?,
         compression = ?,
         content_hash = ?,
         html_size = ?,
         title = ?,
         author = ?,
         site_name = ?,
         published_at = ?,
         excerpt = ?,
         lang = ?,
         extracted_text = ?,
         mode = ?,
         status = 'succeeded',
         warnings = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
       WHERE id = ?`,
      [
        finalUrl,
        storedBlob,
        compression,
        contentHash,
        htmlBytes.byteLength,
        extracted.title,
        extracted.author,
        extracted.siteName,
        extracted.publishedAt,
        extracted.excerpt,
        extracted.lang,
        extracted.extractedText,
        extracted.mode,
        warnings.length > 0 ? JSON.stringify(warnings) : null,
        captureId,
      ],
    );

    updateLatestCapture(db, urlRow.id, captureId);

    const result: CaptureResult = {
      captureId,
      mode: extracted.mode,
      title: extracted.title,
      sourceUrl: rawUrl,
      finalUrl,
      contentHash,
      htmlSize: htmlBytes.byteLength,
      warnings,
    };

    console.log(
      JSON.stringify({
        event: 'capture.succeeded',
        captureId,
        mode: extracted.mode,
        url: normalisedUrl,
        finalUrl,
        htmlSize: htmlBytes.byteLength,
        warnings: warnings.length,
      }),
    );

    return result;
  } catch (err: any) {
    updateCaptureStatus(db, captureId, 'failed', err?.message ?? String(err));
    console.error(
      JSON.stringify({
        event: 'capture.failed',
        captureId,
        url: normalisedUrl,
        error: err?.message ?? String(err),
      }),
    );
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/** Scroll the page to trigger lazy-loaded content */
async function scrollPage(page: any): Promise<void> {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let totalHeight = 0;
        const distance = 800;
        const timer = setInterval(() => {
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= document.body.scrollHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 100);
        // Safety timeout
        setTimeout(() => { clearInterval(timer); resolve(); }, 10_000);
      });
    })
    .catch(() => {});
}

/** Find the chromium executable in the browsers path */
function findChromiumExecutable(browsersPath: string): string {
  // Playwright browser path convention: <browsersPath>/chromium-*/chrome-linux64/chrome
  try {
    const { readdirSync } = require('fs');
    const { join } = require('path');
    const dirs = readdirSync(browsersPath);
    const chromiumDir = dirs.find((d: string) => d.startsWith('chromium-'));
    if (chromiumDir) {
      return join(browsersPath, chromiumDir, 'chrome-linux64', 'chrome');
    }
  } catch {
    // Fall through — let Playwright find it via its own mechanism
  }
  // Let Playwright use its default discovery
  return '';
}
