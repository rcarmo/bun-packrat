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
import { removeArchivedOverlays } from './canonical.js';
import { collectImageSources } from './assets.js';
import {
  attachSourcePdf,
  beginPdfExtraction,
  getCaptureById,
  getOrCreateUrl,
  getSourcePdfBytes,
  insertCapture,
  updateCaptureStatus,
  updateLatestCapture,
  findRecentCapture,
  addCaptureAlias,
  savePdfExtraction,
  setCaptureImageSources,
} from '../db/index.js';
import { ConfirmedPdfDownloadError, downloadPdf, NotPdfSourceError } from '../pdf/download.js';
import type { DownloadedPdf } from '../pdf/download.js';
import { extractPdf } from '../pdf/extract.js';

export interface PipelineOptions {
  config: PackratConfig;
  db: Database;
  force?: boolean;
}

const TOOL_VERSION = 'packrat/0.2.8';

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
      if (recent.source_pdf_sha256 && ['pending', 'running'].includes(recent.source_pdf_extraction_status ?? '')) {
        const bytes = getSourcePdfBytes(db, recent.id);
        if (bytes) await extractStoredPdf(db, recent.id, bytes, config);
      }
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

  // 3. A PDF-looking URL takes the bounded direct path before Chromium. MIME
  // and extension remain hints only: storage still requires a %PDF- signature.
  if (hasPdfUrlHint(normalisedUrl)) {
    try {
      const downloaded = await downloadPdf(normalisedUrl, {
        maxBytes: config.maxPdfSizeBytes,
        timeoutMs: config.captureTimeoutMs,
      });
      return await storeDirectPdf(rawUrl, normalisedUrl, downloaded, opts, startedAt);
    } catch (error) {
      // A signature-confirmed PDF that crosses a hard limit must not fall back
      // to an unbounded browser capture. Other responses preserve HTML/MHTML.
      if (error instanceof ConfirmedPdfDownloadError) throw error;
    }
  }

  // 4. Create a capture row in pending state
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
    // 5. Launch browser
    browser = await withDeadline(chromium.launch({
      headless: true,
      executablePath: findChromiumExecutable(config.playwrightBrowsersPath),
    }), config.captureTimeoutMs, 'Chromium launch');

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (compatible; packrat-archiver/0.2; +https://github.com/rcarmo/bun-packrat)',
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

    // 4. Require the primary document to parse, then treat stricter readiness
    // states as bounded settling signals. News/analytics pages can keep
    // connections alive indefinitely and must not fail a valid capture solely
    // because global network silence never arrives.
    const response = await page.goto(normalisedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.captureTimeoutMs,
    });

    if (!response) {
      throw new Error(`Navigation to ${normalisedUrl} returned no response`);
    }

    // Extensionless PDF responses are recognised by MIME only as a hint, then
    // re-fetched through the byte-bounded signature-validating path. Ordinary
    // HTML pages are not pre-fetched and retain the v0.1.0 single navigation.
    const responseMime = response.headers()['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
    if (responseMime === 'application/pdf') {
      try {
        const downloaded = await downloadPdf(normalisedUrl, {
          maxBytes: config.maxPdfSizeBytes,
          timeoutMs: config.captureTimeoutMs,
        });
        await closePlaywrightResource(context, 5_000);
        await closePlaywrightResource(browser, 5_000);
        browser = null;
        db.exec('DELETE FROM captures WHERE id=?', [captureId]);
        return await storeDirectPdf(rawUrl, normalisedUrl, downloaded, opts, startedAt);
      } catch (error) {
        // Mislabelled HTML keeps the already-loaded browser capture. Only a
        // byte-confirmed PDF hard failure aborts instead of falling back.
        if (!(error instanceof NotPdfSourceError)) throw error;
      }
    }

    const readinessWarning = await waitForCaptureReadiness(page, config.captureWaitUntil, config.captureTimeoutMs);
    if (readinessWarning) warnings.push(readinessWarning);

    const finalUrl = page.url();
    await guardSsrfResolved(finalUrl);
    const httpStatus = response.status();

    if (httpStatus >= 400) {
      warnings.push(`HTTP ${httpStatus} response for ${finalUrl}`);
    }

    if (config.captureSettlingMs > 0) await page.waitForTimeout(config.captureSettlingMs);

    // 5. Materialise lazy content, then preserve Chromium's rendered page as
    // canonical MHTML. Consent cleanup is applied only to the disposable HTML
    // used for extraction and later reading; it never mutates stored bytes.
    await scrollPage(page);
    await materialiseLazyImages(page);
    const renderedHtml = removeArchivedOverlays(await withDeadline(page.content(), config.captureTimeoutMs, 'Rendered HTML collection'));
    const cdp = await withDeadline(context.newCDPSession(page), config.captureTimeoutMs, 'CDP session creation');
    const snapshot = await withDeadline(
      cdp.send('Page.captureSnapshot', { format: 'mhtml' }) as Promise<{ data: string }>,
      config.captureTimeoutMs,
      'MHTML snapshot',
    );
    await closePlaywrightResource(context, 5_000);

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
         body_format = 'mhtml',
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
    if (browser) await closePlaywrightResource(browser, 5_000);
  }
}

export async function withDeadline<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function closePlaywrightResource(resource: { close(): Promise<unknown> }, timeoutMs = 5_000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      resource.close().then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function hasPdfUrlHint(value: string): boolean {
  try {
    const url = new URL(value);
    const decodedPath = decodeURIComponent(url.pathname).toLowerCase();
    return decodedPath.endsWith('.pdf') || [...url.searchParams.values()].some((item) => item.toLowerCase().endsWith('.pdf'));
  } catch { return false; }
}

async function storeDirectPdf(
  rawUrl: string,
  normalisedUrl: string,
  downloaded: DownloadedPdf,
  opts: PipelineOptions,
  startedAt: number,
): Promise<CaptureResult> {
  const { config, db } = opts;
  const urlRow = getOrCreateUrl(db, normalisedUrl, rawUrl);
  const existing = db.query<{ id: number }, [string]>(`
    SELECT cp.capture_id id FROM capture_pdfs cp JOIN pdf_blobs pb ON pb.id=cp.pdf_blob_id
    WHERE pb.sha256=? ORDER BY cp.capture_id LIMIT 1
  `).get(downloaded.sha256);
  if (existing) {
    addCaptureAlias(db, existing.id, rawUrl, 'original');
    if (downloaded.finalUrl !== rawUrl) addCaptureAlias(db, existing.id, downloaded.finalUrl, 'redirect');
    const capture = db.query<{ title: string | null; warnings: string | null }, [number]>(
      'SELECT title,warnings FROM captures WHERE id=?',
    ).get(existing.id);
    const existingMetadata = getCaptureById(db, existing.id);
    if (existingMetadata && ['pending', 'running'].includes(existingMetadata.source_pdf_extraction_status ?? '')) {
      await extractStoredPdf(db, existing.id, downloaded.bytes, config);
    }
    return {
      captureId: existing.id, mode: 'pdf', title: capture?.title ?? downloaded.filename,
      sourceUrl: rawUrl, finalUrl: downloaded.finalUrl, contentHash: downloaded.sha256,
      htmlSize: 0, pdfSize: downloaded.bytes.byteLength,
      warnings: capture?.warnings ? JSON.parse(capture.warnings) : [],
    };
  }

  const captureId = insertCapture(db, {
    url_id: urlRow.id, source_url: rawUrl, final_url: downloaded.finalUrl,
    html: null, compression: 'none', content_hash: downloaded.sha256, html_size: null,
    title: downloaded.filename, author: null, site_name: null, published_at: null,
    excerpt: null, lang: null, extracted_text: downloaded.filename ?? rawUrl,
    mode: 'pdf', status: 'succeeded', capture_tool: 'packrat/0.2.8', warnings: null,
  });
  db.transaction(() => {
    attachSourcePdf(db, {
      captureId, bytes: downloaded.bytes, sourceKind: 'direct',
      sourceMime: downloaded.mimeType, sourceFilename: downloaded.filename,
      sourceLocator: downloaded.finalUrl,
    });
    updateLatestCapture(db, urlRow.id, captureId);
    addCaptureAlias(db, captureId, rawUrl, 'original');
    if (downloaded.finalUrl !== rawUrl) addCaptureAlias(db, captureId, downloaded.finalUrl, 'redirect');
  })();

  // Storage success is independent of extraction success. PDF.js runs in an
  // isolated worker and the stored PDF remains available on timeout/failure.
  const pdfSize = downloaded.bytes.byteLength;
  const extraction = await extractStoredPdf(db, captureId, downloaded.bytes, config);
  if (extraction.title) {
    db.query(`UPDATE captures SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`)
      .run(extraction.title, captureId);
  }
  db.query('UPDATE captures SET capture_duration_ms=? WHERE id=?')
    .run(Math.round(performance.now() - startedAt), captureId);

  return {
    captureId, mode: 'pdf', title: extraction.title ?? downloaded.filename,
    sourceUrl: rawUrl, finalUrl: downloaded.finalUrl, contentHash: downloaded.sha256,
    htmlSize: 0, pdfSize, warnings: extraction.warnings,
  };
}

async function extractStoredPdf(db: Database, captureId: number, bytes: Uint8Array, config: PackratConfig) {
  beginPdfExtraction(db, captureId, 'pdfjs-dist/5.4.149');
  let extraction;
  try {
    extraction = await extractPdf(bytes, {
      timeoutMs: config.pdfExtractionTimeoutMs,
      maxPages: config.maxPdfPages,
      maxTextBytes: config.maxPdfTextBytes,
    });
  } catch (error: any) {
    const message = String(error?.message ?? error).slice(0, 1000);
    extraction = {
      status: 'failed' as const, pageCount: null, title: null, text: '', textBytes: 0,
      textTruncated: false, warnings: [`PDF text extraction failed: ${message}`], error: message,
    };
  }
  savePdfExtraction(db, captureId, { ...extraction, extractor: 'pdfjs-dist/5.4.149' });
  return extraction;
}

export async function waitForCaptureReadiness(
  page: Pick<any, 'waitForLoadState'>,
  waitUntil: PackratConfig['captureWaitUntil'],
  captureTimeoutMs: number,
): Promise<string | null> {
  if (waitUntil === 'commit' || waitUntil === 'domcontentloaded') return null;
  const timeout = Math.min(10_000, Math.max(1_000, Math.floor(captureTimeoutMs / 4)));
  try {
    await page.waitForLoadState(waitUntil, { timeout });
    return null;
  } catch {
    return `Page did not reach ${waitUntil} within ${timeout}ms; continued after DOM content loaded`;
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

/** Ask browser-native lazy images to load before the canonical snapshot. This
 * does not fetch anything outside the guarded Playwright context. */
async function materialiseLazyImages(page: any): Promise<void> {
  await page.evaluate(() => {
    document.querySelectorAll('img').forEach((image) => {
      image.loading = 'eager';
      const fallback = image.getAttribute('data-src') ?? image.getAttribute('data-lazy-src') ?? image.getAttribute('data-original');
      if (!image.currentSrc && !image.src && fallback) image.src = fallback;
    });
  }).catch(() => {});
  await page.waitForTimeout(750);
  await page.evaluate(async () => {
    const images = Array.from(document.images);
    await Promise.all(images.map((image) => image.decode().catch(() => {})));
  }).catch(() => {});
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
