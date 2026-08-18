/**
 * bun-packrat — configuration
 * All values can be overridden via environment variables.
 */

import type { PackratConfig } from './types.js';

export function loadConfig(): PackratConfig {
  const compression = process.env.PACKRAT_HTML_COMPRESSION ?? 'none';
  if (compression !== 'none' && compression !== 'gzip') {
    throw new Error('PACKRAT_HTML_COMPRESSION must be "none" or "gzip"');
  }

  const waitUntil = process.env.PACKRAT_CAPTURE_WAIT_UNTIL ?? 'networkidle';
  if (!['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil)) {
    throw new Error('PACKRAT_CAPTURE_WAIT_UNTIL must be load, domcontentloaded, networkidle, or commit');
  }

  return {
    dbPath: process.env.PACKRAT_DB ?? './data/packrat.db',
    port: readPositiveInt('PORT', 3047, 65535),
    host: process.env.HOST ?? '0.0.0.0',
    playwrightBrowsersPath:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      '/workspace/bin/pw-browsers',
    maxPageSizeBytes: readPositiveInt('PACKRAT_MAX_PAGE_BYTES', 20 * 1024 * 1024),
    maxAssetSizeBytes: readPositiveInt('PACKRAT_MAX_ASSET_BYTES', 5 * 1024 * 1024),
    maxPdfSizeBytes: readPositiveInt('PACKRAT_MAX_PDF_BYTES', 100 * 1024 * 1024),
    pdfExtractionTimeoutMs: readPositiveInt('PACKRAT_PDF_EXTRACTION_TIMEOUT_MS', 60_000),
    maxPdfPages: readPositiveInt('PACKRAT_MAX_PDF_PAGES', 1_000),
    maxPdfTextBytes: readPositiveInt('PACKRAT_MAX_PDF_TEXT_BYTES', 10 * 1024 * 1024),
    captureTimeoutMs: readPositiveInt('PACKRAT_CAPTURE_TIMEOUT_MS', 60_000),
    maxConcurrentCaptures: readPositiveInt('PACKRAT_MAX_CONCURRENT_CAPTURES', 2, 16),
    htmlCompression: compression,
    baseUrl: process.env.PACKRAT_BASE_URL ?? 'http://localhost:3047',
    freshnessSeconds: readNonNegativeInt('PACKRAT_FRESHNESS_SECONDS', 86_400),
    captureWaitUntil: waitUntil as PackratConfig['captureWaitUntil'],
    captureSettlingMs: readNonNegativeInt('PACKRAT_CAPTURE_SETTLING_MS', 1_000, 60_000),
    authUser: process.env.PACKRAT_AUTH_USER ?? 'packrat',
    authPassword: process.env.PACKRAT_AUTH_PASSWORD ?? '',
    authDisabled: process.env.PACKRAT_AUTH_DISABLED === '1',
  };
}

function readNonNegativeInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${name} must be an integer between 0 and ${max}`);
  }
  return value;
}

function readPositiveInt(name: string, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}
