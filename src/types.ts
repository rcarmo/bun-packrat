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
  html: Buffer | null;
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
  /** 'none' | 'gzip' — zstd reserved for future Bun native support */
  htmlCompression: Compression;
  /** base URL of this service, for self-links */
  baseUrl: string;
}
