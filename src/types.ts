/**
 * bun-packrat — shared TypeScript types
 */

export type CaptureMode =
  | 'article'
  | 'full_page'
  | 'imported_singlefile'
  | 'metadata_only';

export type CaptureStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type Compression = 'none' | 'gzip' | 'zstd';

export type JobKind = 'capture' | 'import_archivebox' | 'export';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export interface CaptureRow {
  id: number;
  url_id: number;
  source_url: string;
  final_url: string;
  html: Uint8Array | null;
  compression: Compression;
  content_hash: string | null;
  html_size: number | null;
  title: string | null;
  author: string | null;
  site_name: string | null;
  published_at: string | null;
  excerpt: string | null;
  lang: string | null;
  extracted_text: string | null;
  mode: CaptureMode;
  status: CaptureStatus;
  capture_tool: string;
  warnings: string | null;
  error: string | null;
  note: string | null;
  capture_duration_ms: number | null;
  captured_at: string;
  created_at: string;
  updated_at: string;
}

export interface UrlRow {
  id: number;
  normalised: string;
  original: string;
  domain: string;
  latest_capture: number | null;
  created_at: string;
  updated_at: string;
}

export interface JobRow {
  id: number;
  kind: JobKind;
  status: JobStatus;
  capture_id: number | null;
  payload: string | null;
  result: string | null;
  error: string | null;
  attempt_count: number;
  max_attempts: number;
  queued_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
}

/** Capture request — input to the pipeline */
export interface CaptureRequest {
  url: string;
  /** hint: force article mode or full_page */
  mode?: 'article' | 'full_page';
  /** max time (ms) to wait for page load, default from config */
  timeout?: number;
}

/** Capture result — output of the pipeline */
export interface CaptureResult {
  captureId: number;
  mode: CaptureMode;
  title: string | null;
  sourceUrl: string;
  finalUrl: string;
  contentHash: string;
  htmlSize: number;
  warnings: string[];
}

/** Config shape — see config.ts */
export interface PackratConfig {
  dbPath: string;
  port: number;
  host: string;
  playwrightBrowsersPath: string;
  maxPageSizeBytes: number;
  maxAssetSizeBytes: number;
  captureTimeoutMs: number;
  maxConcurrentCaptures: number;
  /** Supported storage compression formats. */
  htmlCompression: 'none' | 'gzip';
  /** base URL of this service, for self-links */
  baseUrl: string;
  /** Recent successful capture reuse window; 0 disables reuse. */
  freshnessSeconds: number;
  /** Playwright navigation readiness condition. */
  captureWaitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  /** Additional settling delay after navigation. */
  captureSettlingMs: number;
  /** HTTP Basic authentication. Empty password is allowed only when explicitly disabled. */
  authUser: string;
  authPassword: string;
  authDisabled: boolean;
}
