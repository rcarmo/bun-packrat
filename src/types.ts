/**
 * bun-packrat — shared TypeScript types
 */

export type CaptureMode =
  | 'article'
  | 'full_page'
  | 'imported_singlefile'
  | 'metadata_only'
  | 'pdf';

export type CaptureStatus =
  | 'pending'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

export type Compression = 'none' | 'gzip' | 'zstd';
export type CanonicalBodyFormat = 'html' | 'mhtml';
export type PdfSourceKind = 'direct' | 'archivebox_original';
export type PdfExtractionStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timeout'
  | 'encrypted'
  | 'image_only';

export type JobKind = 'capture' | 'import_archivebox' | 'export';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/** Capture fields safe for ordinary list and detail requests. Large canonical
 * bodies and extracted text are deliberately excluded. */
export interface CaptureMetadataRow {
  id: number;
  url_id: number;
  source_url: string;
  final_url: string;
  compression: Compression;
  content_hash: string | null;
  html_size: number | null;
  body_format: CanonicalBodyFormat | null;
  source_pdf_sha256: string | null;
  source_pdf_size: number | null;
  source_pdf_extraction_status: PdfExtractionStatus | null;
  title: string | null;
  author: string | null;
  site_name: string | null;
  published_at: string | null;
  excerpt: string | null;
  lang: string | null;
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
  /** Present on list/search results. */
  domain?: string;
}

/** Full legacy capture row. Use only for writes or explicitly body-bearing
 * operations; metadata reads return CaptureMetadataRow instead. */
export interface CaptureRow extends CaptureMetadataRow {
  html: Uint8Array | null;
  extracted_text: string | null;
}

export interface CaptureBodyRow {
  html: Uint8Array | null;
  compression: Compression;
}

export interface SourcePdfMetadata {
  capture_id: number;
  pdf_blob_id: number;
  sha256: string;
  byte_size: number;
  source_kind: PdfSourceKind;
  source_mime: string | null;
  source_filename: string | null;
  source_locator: string | null;
  extraction_status: PdfExtractionStatus;
  page_count: number | null;
  extracted_text_bytes: number | null;
  text_truncated: number;
  extraction_warnings: string | null;
  extraction_error: string | null;
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
  /** hint: force article mode, full_page, or direct PDF */
  mode?: 'article' | 'full_page' | 'pdf';
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
  pdfSize?: number;
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
  maxPdfSizeBytes: number;
  pdfExtractionTimeoutMs: number;
  maxPdfPages: number;
  maxPdfTextBytes: number;
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
