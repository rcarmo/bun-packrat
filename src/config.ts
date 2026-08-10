/**
 * bun-packrat — configuration
 * All values can be overridden via environment variables.
 */

import type { PackratConfig } from './types.js';

export function loadConfig(): PackratConfig {
  return {
    dbPath: process.env.PACKRAT_DB ?? './data/packrat.db',
    port: parseInt(process.env.PORT ?? '3047', 10),
    host: process.env.HOST ?? '0.0.0.0',
    playwrightBrowsersPath:
      process.env.PLAYWRIGHT_BROWSERS_PATH ??
      '/workspace/bin/pw-browsers',
    maxPageSizeBytes: parseInt(
      process.env.PACKRAT_MAX_PAGE_BYTES ?? String(20 * 1024 * 1024), // 20 MB
      10,
    ),
    maxAssetSizeBytes: parseInt(
      process.env.PACKRAT_MAX_ASSET_BYTES ?? String(5 * 1024 * 1024), // 5 MB
      10,
    ),
    captureTimeoutMs: parseInt(
      process.env.PACKRAT_CAPTURE_TIMEOUT_MS ?? '60000', // 60 s
      10,
    ),
    maxConcurrentCaptures: parseInt(
      process.env.PACKRAT_MAX_CONCURRENT_CAPTURES ?? '2',
      10,
    ),
    htmlCompression: (process.env.PACKRAT_HTML_COMPRESSION ?? 'none') as
      | 'none'
      | 'gzip',
    baseUrl: process.env.PACKRAT_BASE_URL ?? 'http://localhost:3047',
  };
}
