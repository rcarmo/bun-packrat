/**
 * bun-packrat — Playwright capture pipeline
 *
 * Orchestrates browser launch → page load → canonical Chromium MHTML snapshot
 * → derived extraction metadata → storage.
 */

import { chromium } from 'playwright';
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { PackratConfig, CaptureResult } from '../types.js';
import { normaliseUrl, guardSsrfResolved, UrlValidationError } from './url.js';
import { extractContent } from './extract.js';
import { collectImageSources } from './assets.js';
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
    mode: 'full_page',
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

    // 5. Scroll lazy content into view and dismiss bounded overlays before the
    // canonical snapshot. MHTML keeps Chromium's rendered DOM and loaded
    // resources together without a second asset-fetching pass.
    await scrollPage(page);
    await page.evaluate(DISMISS_OVERLAYS_JS).catch(() => {});
    const renderedHtml = await page.content();
    const cdp = await context.newCDPSession(page);
    const snapshot = await cdp.send('Page.captureSnapshot', { format: 'mhtml' }) as { data: string };
    await context.close();

    const canonicalBytes = Buffer.from(snapshot.data, 'utf-8');
    if (canonicalBytes.byteLength > config.maxPageSizeBytes) {
      throw new Error(`Captured MHTML exceeds max size (${canonicalBytes.byteLength} > ${config.maxPageSizeBytes} bytes)`);
    }

    // 6. Readability supplies derived metadata and search text. It never
    // replaces the canonical full-page snapshot.
    const extracted = extractContent(renderedHtml, finalUrl);
    warnings.push(...extracted.extractionWarnings);
    const renderedTextLength = extracted.extractedText?.length ?? 0;
    if (extracted.mode === 'full_page') warnings.push('Readability yielded no article; derived views use the full rendered page');
    const { imageSources, warnings: imageWarnings } = collectImageSources(extracted.articleHtml ?? renderedHtml, finalUrl);
    warnings.push(...imageWarnings);

    // 7. Hash and optionally compress the canonical MHTML bytes.
    const contentHash = createHash('sha256').update(canonicalBytes).digest('hex');
    let storedBlob: Buffer = canonicalBytes;
    let compression: 'none' | 'gzip' = 'none';

    if (config.htmlCompression === 'gzip') {
      const { gzipSync } = await import('zlib');
      storedBlob = gzipSync(canonicalBytes);
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
        canonicalBytes.byteLength,
        extracted.title,
        extracted.author,
        extracted.siteName,
        extracted.publishedAt,
        extracted.excerpt,
        extracted.lang,
        extracted.extractedText,
        'full_page',
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
      mode: 'full_page',
      title: extracted.title,
      sourceUrl: rawUrl,
      finalUrl,
      contentHash,
      htmlSize: canonicalBytes.byteLength,
      warnings,
    };

    console.log(
      JSON.stringify({
        event: 'capture.succeeded',
        captureId,
        mode: 'full_page',
        extractedTextLength: renderedTextLength,
        url: normalisedUrl,
        finalUrl,
        htmlSize: canonicalBytes.byteLength,
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
export function formatImageRecoveryWarning(readabilityImages: number, sanitisedHtml: string): string {
  const finalImages = (sanitisedHtml.match(/<img\b/gi) ?? []).length;
  return `Readability omitted article images; recovered semantic article container (${readabilityImages} → ${finalImages} images retained)`;
}

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
