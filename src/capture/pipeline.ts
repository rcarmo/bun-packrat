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
import { normaliseUrl, guardSsrfResolved, UrlValidationError } from './url.js';
import { extractContent } from './extract.js';
import { sanitizeHtml } from './sanitize.js';
import { inlineAssets } from './assets.js';
import { assembleHtml } from './assemble.js';
import { DISMISS_OVERLAYS_JS } from './overlays.js';
import {
  getOrCreateUrl,
  insertCapture,
  updateCaptureStatus,
  updateLatestCapture,
  findRecentCapture,
  addCaptureAlias,
  setCaptureImageSources,
} from '../db/index.js';

export interface PipelineOptions {
  config: PackratConfig;
  db: Database;
  force?: boolean;
}

const TOOL_VERSION = 'packrat/0.1.0';

/**
 * Run the full capture pipeline for a URL.
 * Returns the CaptureResult on success; throws on validation or capture failure.
 */
export async function capturePage(
  rawUrl: string,
  opts: PipelineOptions,
): Promise<CaptureResult> {
  const { config, db } = opts;
  const startedAt = performance.now();

  // 1. Validate and normalise URL
  let normalisedUrl: string;
  try {
    normalisedUrl = normaliseUrl(rawUrl);
    await guardSsrfResolved(normalisedUrl);
  } catch (err) {
    if (err instanceof UrlValidationError) throw err;
    throw new Error(`URL validation failed: ${err}`);
  }

  // 2. Reuse a fresh successful capture unless the caller explicitly asks
  // for a recapture.
  if (!opts.force) {
    const recent = findRecentCapture(db, normalisedUrl, config.freshnessSeconds);
    if (recent) {
      return {
        captureId: recent.id,
        mode: recent.mode,
        title: recent.title,
        sourceUrl: recent.source_url,
        finalUrl: recent.final_url,
        contentHash: recent.content_hash ?? '',
        htmlSize: recent.html_size ?? 0,
        warnings: recent.warnings ? JSON.parse(recent.warnings) : [],
      };
    }
  }

  // 3. Create a capture row in pending state
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
    // 4. Launch browser
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

    // Validate DNS for every browser request, not just the submitted URL.
    // This blocks pages from using scripts/images/fetches as an SSRF proxy.
    // Cache one decision per origin to avoid repeating DNS lookups.
    const originGuards = new Map<string, Promise<void>>();
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (!requestUrl.startsWith('http://') && !requestUrl.startsWith('https://')) {
        await route.continue();
        return;
      }
      try {
        const origin = new URL(requestUrl).origin;
        let guard = originGuards.get(origin);
        if (!guard) {
          guard = guardSsrfResolved(requestUrl);
          originGuards.set(origin, guard);
        }
        await guard;
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });

    // 4. Navigate
    const response = await page.goto(normalisedUrl, {
      waitUntil: config.captureWaitUntil,
      timeout: config.captureTimeoutMs,
    });

    if (!response) {
      throw new Error(`Navigation to ${normalisedUrl} returned no response`);
    }

    const finalUrl = page.url();
    await guardSsrfResolved(finalUrl);
    const httpStatus = response.status();

    if (httpStatus >= 400) {
      warnings.push(`HTTP ${httpStatus} response for ${finalUrl}`);
    }

    if (config.captureSettlingMs > 0) await page.waitForTimeout(config.captureSettlingMs);

    // 5. Scroll for lazy content, then snapshot the rendered DOM before any
    // overlay cleanup. Extraction uses this complete snapshot so an imperfect
    // overlay heuristic cannot delete article content.
    await scrollPage(page);
    const renderedHtml = await page.content();
    await page.evaluate(DISMISS_OVERLAYS_JS).catch(() => {});
    const cleanedFullPageHtml = await page.content();

    // 6. Close the browser context once both snapshots are available.

    await context.close();

    if (Buffer.byteLength(renderedHtml, 'utf-8') > config.maxPageSizeBytes * 2) {
      throw new Error('Rendered page exceeds the configured capture size budget');
    }

    // 7. Extract article content
    const extracted = extractContent(renderedHtml, finalUrl);
    const renderedTextLength = extracted.extractedText?.length ?? 0;
    if (extracted.mode === 'full_page') {
      warnings.push('Readability extraction failed or yielded too little text; using full-page mode');
    }

    // 8. Inline external assets
    const { html: htmlWithAssets, warnings: assetWarnings, imageSources } = await inlineAssets(
      extracted.articleHtml ?? cleanedFullPageHtml,
      {
        baseUrl: finalUrl,
        maxAssetBytes: config.maxAssetSizeBytes,
      },
    );
    warnings.push(...assetWarnings);

    // 9. Sanitise
    const { html: sanitisedHtml, warnings: sanitiseWarnings } = sanitizeHtml(htmlWithAssets);
    warnings.push(...sanitiseWarnings);

    // 10. Assemble final document. Embed a reproducible hash of the sanitised
    // body; the database content_hash below covers the complete document.
    const capturedAt = new Date().toISOString();
    const bodyContentHash = createHash('sha256').update(sanitisedHtml, 'utf-8').digest('hex');
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
      bodyContentHash,
    });

    // Size guard: fail explicitly rather than storing an oversized body.
    const htmlBytes = Buffer.from(finalHtml, 'utf-8');
    if (htmlBytes.byteLength > config.maxPageSizeBytes) {
      throw new Error(
        `Captured page exceeds max size (${htmlBytes.byteLength} > ${config.maxPageSizeBytes} bytes)`,
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

    // 13. Commit the canonical body, metadata, URL pointer and aliases as one
    // transaction so readers never observe a partially completed capture.
    db.transaction(() => {
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
         capture_duration_ms = ?,
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
        Math.round(performance.now() - startedAt),
        captureId,
      ],
      );
      updateLatestCapture(db, urlRow.id, captureId);
      addCaptureAlias(db, captureId, rawUrl, 'original');
      if (finalUrl !== rawUrl) addCaptureAlias(db, captureId, finalUrl, 'redirect');
      setCaptureImageSources(db, captureId, imageSources);
    })();

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
        extractedTextLength: renderedTextLength,
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
export function findChromiumExecutable(browsersPath: string): string | undefined {
  // Playwright browser path convention: <browsersPath>/chromium-*/chrome-linux64/chrome
  try {
    const { readdirSync } = require('fs');
    const { join } = require('path');
    const dirs = readdirSync(browsersPath);
    const candidates = dirs
      .filter((d: string) => d.startsWith('chromium-'))
      .sort((a: string, b: string) => b.localeCompare(a, undefined, { numeric: true }));
    for (const chromiumDir of candidates) {
      const executable = join(browsersPath, chromiumDir, 'chrome-linux64', 'chrome');
      if (require('fs').existsSync(executable)) return executable;
    }
  } catch {
    // Fall through — let Playwright find it via its own mechanism
  }
  // Let Playwright use its default discovery. Passing an empty string makes
  // Chromium try to execute the current directory and fail cryptically.
  return undefined;
}
