import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { attachSourcePdf, beginPdfExtraction, getSourcePdfBytes, getSourcePdfMetadata, savePdfExtraction } from '../db/index.js';
import { extractPdf } from '../pdf/extract.js';

const MAX_HEADERS_BYTES = 1024 * 1024;

interface ArchiveBoxPdfOptions {
  dataRoot: string;
  sourceDatabase?: string;
  maxPdfBytes: number;
  extractionTimeoutMs: number;
  maxPages: number;
  maxTextBytes: number;
  limit?: number;
  retryFailed?: boolean;
  verifyOnly?: boolean;
}

interface SourceResult {
  extractor: string;
  status: string;
  output: string;
}

interface EnrichmentRow {
  id: number;
  ab_id: string;
  ab_timestamp: string | null;
  capture_id: number | null;
  status: string;
}

export interface OriginalPdfCandidate {
  path: string;
  relativePath: string;
  byteSize: number;
  mimeType: string;
}

export interface ArchiveBoxPdfReport {
  ok: boolean;
  sourceRows: number;
  processed: number;
  resumed: number;
  statuses: Record<string, number>;
  pdfBlobs: number;
  pdfBytes: number;
  failures: Array<{ abId: string; detail: string }>;
  elapsedMs: number;
}

/** Accept only ArchiveBox's original wget response backed by successful
 * headers extraction. Browser print-to-PDF extractor output is never examined. */
export function classifyArchiveBoxOriginalPdf(
  archiveRoot: string,
  timestamp: string,
  results: SourceResult[],
  maxPdfBytes: number,
): { candidate: OriginalPdfCandidate | null; detail: string } {
  const successfulWget = [...new Set(results
    .filter((row) => row.extractor === 'wget' && row.status === 'succeeded')
    .map((row) => row.output))];
  const successfulHeaders = [...new Set(results
    .filter((row) => row.extractor === 'headers' && row.status === 'succeeded')
    .map((row) => row.output))];
  if (successfulWget.length !== 1 || successfulHeaders.length !== 1) {
    return { candidate: null, detail: 'No unambiguous successful wget and headers output pair' };
  }
  const base = resolve(archiveRoot, timestamp);
  const sourcePath = safeArchivePath(base, successfulWget[0]);
  const headersPath = safeArchivePath(base, successfulHeaders[0]);
  if (!sourcePath || !headersPath) return { candidate: null, detail: 'ArchiveBox output path escapes its snapshot directory' };
  if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) return { candidate: null, detail: 'Successful wget output is missing' };
  if (!existsSync(headersPath) || !statSync(headersPath).isFile()) return { candidate: null, detail: 'Successful headers output is missing' };
  const sourceStat = statSync(sourcePath);
  if (sourceStat.size < 5) return { candidate: null, detail: 'Original response is too small to be a PDF' };
  if (sourceStat.size > maxPdfBytes) return { candidate: null, detail: `Original PDF exceeds the ${maxPdfBytes} byte limit` };
  if (statSync(headersPath).size > MAX_HEADERS_BYTES) return { candidate: null, detail: 'ArchiveBox headers metadata exceeds its bounded read limit' };

  let headers: Record<string, unknown>;
  try { headers = JSON.parse(readFileSync(headersPath, 'utf8')); }
  catch { return { candidate: null, detail: 'ArchiveBox headers metadata is invalid JSON' }; }
  const mimeType = headerValue(headers, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (mimeType !== 'application/pdf') return { candidate: null, detail: 'Recorded original response MIME type is not application/pdf' };
  const contentLength = headerValue(headers, 'content-length');
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) !== sourceStat.size) {
    return { candidate: null, detail: 'Recorded original response Content-Length does not match the source file' };
  }
  const signature = Buffer.alloc(5);
  const descriptor = openSync(sourcePath, 'r');
  try { readSync(descriptor, signature, 0, signature.length, 0); }
  finally { closeSync(descriptor); }
  if (!signature.equals(Buffer.from('%PDF-'))) return { candidate: null, detail: 'Original response does not start with %PDF-' };
  return {
    candidate: {
      path: sourcePath,
      relativePath: join('archive', timestamp, relative(base, sourcePath)),
      byteSize: sourceStat.size,
      mimeType,
    },
    detail: 'Verified original wget response with application/pdf headers and %PDF- signature',
  };
}

export async function enrichArchiveBoxPdfs(target: Database, options: ArchiveBoxPdfOptions): Promise<ArchiveBoxPdfReport> {
  const started = performance.now();
  const dataRoot = resolve(options.dataRoot);
  const archiveRoot = join(dataRoot, 'archive');
  const sourcePath = resolve(options.sourceDatabase ?? join(dataRoot, 'index.sqlite3'));
  if (!existsSync(sourcePath)) throw new Error(`ArchiveBox database not found: ${sourcePath}`);
  if (!existsSync(archiveRoot)) throw new Error(`ArchiveBox archive directory not found: ${archiveRoot}`);
  const source = new Database(sourcePath, { readonly: true, strict: true });
  try {
    requireSourceColumns(source);
    seedEnrichmentRows(target);
    const report: ArchiveBoxPdfReport = {
      ok: true, sourceRows: target.query<{ n: number }, []>('SELECT count(*) n FROM archivebox_imports').get()?.n ?? 0,
      processed: 0, resumed: 0, statuses: {}, pdfBlobs: 0, pdfBytes: 0, failures: [], elapsedMs: 0,
    };
    if (options.verifyOnly) {
      verifyEnrichment(target, source, archiveRoot, options.maxPdfBytes, report);
      return finishReport(target, report, started);
    }

    const rows = target.query<EnrichmentRow, [number]>(`
      SELECT ai.id,ai.ab_id,ai.ab_timestamp,ai.capture_id,ape.status
      FROM archivebox_imports ai JOIN archivebox_pdf_enrichment ape ON ape.archivebox_import_id=ai.id
      WHERE ape.status='pending' OR (?=1 AND ape.status='failed')
      ORDER BY ai.id
    `).all(options.retryFailed ? 1 : 0);
    const selected = options.limit && options.limit > 0 ? rows.slice(0, options.limit) : rows;
    report.resumed = report.sourceRows - rows.length;
    const resultQuery = source.query<SourceResult, [string]>(
      'SELECT extractor,status,output FROM core_archiveresult WHERE snapshot_id=? ORDER BY extractor,output',
    );
    for (const row of selected) {
      try {
        if (!row.ab_timestamp) {
          checkpoint(target, row.id, 'failed', null, null, null, row.capture_id, 'ArchiveBox timestamp is missing');
          recordFailure(report, row.ab_id, 'ArchiveBox timestamp is missing');
          report.processed++;
          continue;
        }
        const classified = classifyArchiveBoxOriginalPdf(archiveRoot, row.ab_timestamp, resultQuery.all(row.ab_id), options.maxPdfBytes);
        if (!classified.candidate) {
          checkpoint(target, row.id, 'not_original_pdf', null, null, null, row.capture_id, classified.detail);
          report.processed++;
          continue;
        }
        if (!row.capture_id) throw new Error('ArchiveBox provenance row has no capture to enrich');
        const bytes = readFileSync(classified.candidate.path);
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const pdf = attachSourcePdf(target, {
          captureId: row.capture_id, bytes, sourceKind: 'archivebox_original',
          sourceMime: classified.candidate.mimeType,
          sourceFilename: basename(classified.candidate.path),
          sourceLocator: classified.candidate.relativePath,
        });
        if (pdf.sha256 !== sha256 || pdf.byte_size !== classified.candidate.byteSize) throw new Error('Stored PDF metadata does not match verified source bytes');
        if (pdf.extraction_status === 'pending' || pdf.extraction_status === 'running' || pdf.extraction_status === 'failed' || pdf.extraction_status === 'timeout') {
          beginPdfExtraction(target, row.capture_id, 'pdfjs-dist/5.4.149');
          let extraction;
          try {
            extraction = await extractPdf(bytes, {
              timeoutMs: options.extractionTimeoutMs, maxPages: options.maxPages, maxTextBytes: options.maxTextBytes,
            });
          } catch (error: any) {
            const message = String(error?.message ?? error).slice(0, 1000);
            extraction = { status:'failed' as const,pageCount:null,title:null,text:'',textBytes:0,textTruncated:false,warnings:[`PDF text extraction failed: ${message}`],error:message };
          }
          savePdfExtraction(target, row.capture_id, { ...extraction, extractor: 'pdfjs-dist/5.4.149' });
        }
        target.query(`UPDATE captures SET mode=CASE WHEN body_format IS NULL THEN 'pdf' ELSE mode END,
          updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?`).run(row.capture_id);
        checkpoint(target, row.id, 'enriched', classified.candidate.relativePath, classified.candidate.byteSize, sha256, row.capture_id, classified.detail, pdf.pdf_blob_id);
        report.processed++;
      } catch (error: any) {
        const detail = String(error?.message ?? error).slice(0, 1000);
        checkpoint(target, row.id, 'failed', null, null, null, row.capture_id, detail);
        recordFailure(report, row.ab_id, detail);
        report.processed++;
      }
    }
    return finishReport(target, report, started);
  } finally { source.close(); }
}

function seedEnrichmentRows(db: Database): void {
  db.exec(`INSERT OR IGNORE INTO archivebox_pdf_enrichment (archivebox_import_id,status)
    SELECT id,'pending' FROM archivebox_imports`);
}

function checkpoint(db: Database, importId: number, status: string, path: string | null, size: number | null, sha256: string | null, captureId: number | null, detail: string, blobId: number | null = null): void {
  db.query(`UPDATE archivebox_pdf_enrichment SET status=?,source_path=?,source_size=?,source_sha256=?,
    pdf_blob_id=?,capture_id=?,attempt_count=attempt_count+1,detail=?,processed_at=strftime('%Y-%m-%dT%H:%M:%SZ','now'),
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE archivebox_import_id=?`)
    .run(status, path, size, sha256, blobId, captureId, detail, importId);
}

function finishReport(db: Database, report: ArchiveBoxPdfReport, started: number): ArchiveBoxPdfReport {
  report.statuses = Object.fromEntries(db.query<{ status: string; n: number }, []>(
    'SELECT status,count(*) n FROM archivebox_pdf_enrichment GROUP BY status ORDER BY status',
  ).all().map((row) => [row.status, row.n]));
  const totals = db.query<{ n: number; bytes: number }, []>('SELECT count(*) n,coalesce(sum(byte_size),0) bytes FROM pdf_blobs').get();
  report.pdfBlobs = totals?.n ?? 0;
  report.pdfBytes = totals?.bytes ?? 0;
  report.ok = report.failures.length === 0 && (report.statuses.pending ?? 0) === Math.max(0, report.sourceRows - report.processed - report.resumed);
  report.elapsedMs = Math.round(performance.now() - started);
  return report;
}

function verifyEnrichment(db: Database, source: Database, archiveRoot: string, maxPdfBytes: number, report: ArchiveBoxPdfReport): void {
  const rows = db.query<EnrichmentRow & { source_path: string | null; source_sha256: string | null }, []>(`
    SELECT ai.id,ai.ab_id,ai.ab_timestamp,ai.capture_id,ape.status,ape.source_path,ape.source_sha256
    FROM archivebox_imports ai LEFT JOIN archivebox_pdf_enrichment ape ON ape.archivebox_import_id=ai.id ORDER BY ai.id
  `).all();
  const resultQuery = source.query<SourceResult, [string]>('SELECT extractor,status,output FROM core_archiveresult WHERE snapshot_id=? ORDER BY extractor,output');
  for (const row of rows) {
    if (!row.status || row.status === 'pending') { recordFailure(report, row.ab_id, 'PDF enrichment has no terminal outcome'); continue; }
    if (!row.ab_timestamp) { if (row.status !== 'failed') recordFailure(report, row.ab_id, 'Missing timestamp is not recorded as failed'); continue; }
    const expected = classifyArchiveBoxOriginalPdf(archiveRoot, row.ab_timestamp, resultQuery.all(row.ab_id), maxPdfBytes);
    if (!expected.candidate) {
      if (row.status !== 'not_original_pdf') recordFailure(report, row.ab_id, `Expected not_original_pdf, found ${row.status}`);
      continue;
    }
    if (row.status !== 'enriched' || !row.capture_id) { recordFailure(report, row.ab_id, `Verified original PDF is not enriched (${row.status})`); continue; }
    const sourceBytes = readFileSync(expected.candidate.path);
    const sourceHash = createHash('sha256').update(sourceBytes).digest('hex');
    const stored = getSourcePdfBytes(db, row.capture_id);
    const metadata = getSourcePdfMetadata(db, row.capture_id);
    if (!stored || !metadata || metadata.sha256 !== sourceHash || createHash('sha256').update(stored).digest('hex') !== sourceHash) {
      recordFailure(report, row.ab_id, 'Stored PDF bytes do not match the verified ArchiveBox original');
      continue;
    }
    if (row.source_path !== expected.candidate.relativePath || row.source_sha256 !== sourceHash || metadata.pdf_blob_id !== db.query<{ pdf_blob_id: number | null }, [number]>(
      'SELECT pdf_blob_id FROM archivebox_pdf_enrichment WHERE archivebox_import_id=?',
    ).get(row.id)?.pdf_blob_id) {
      recordFailure(report, row.ab_id, 'PDF enrichment provenance does not match the verified ArchiveBox original');
    }
  }
  report.processed = rows.length;
}

function safeArchivePath(base: string, output: string): string | null {
  if (!output || output.includes('\0')) return null;
  const path = resolve(base, output);
  return path === base || path.startsWith(`${base}${sep}`) ? path : null;
}

function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return entry && (typeof entry[1] === 'string' || typeof entry[1] === 'number') ? String(entry[1]) : null;
}

function requireSourceColumns(db: Database): void {
  for (const [table, columns] of Object.entries({ core_snapshot: ['id', 'timestamp'], core_archiveresult: ['snapshot_id', 'extractor', 'status', 'output'] })) {
    const actual = new Set(db.query<{ name: string }, []>(`PRAGMA table_info("${table}")`).all().map((row) => row.name));
    const missing = columns.filter((column) => !actual.has(column));
    if (missing.length) throw new Error(`Unsupported ArchiveBox schema: ${table} is missing ${missing.join(', ')}`);
  }
}

function recordFailure(report: ArchiveBoxPdfReport, abId: string, detail: string): void {
  if (report.failures.length < 100) report.failures.push({ abId, detail });
}
