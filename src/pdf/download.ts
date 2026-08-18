import { createHash } from 'node:crypto';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guardSsrfResolved, normaliseUrl } from '../capture/url.js';

const PDF_SIGNATURE = Buffer.from('%PDF-');

export type PdfFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface PdfDownloadOptions {
  maxBytes: number;
  timeoutMs: number;
  maxRedirects?: number;
  fetchImpl?: PdfFetch;
  guard?: (url: string) => Promise<void>;
}

export class NotPdfSourceError extends Error {
  constructor(message = 'Downloaded source does not start with %PDF-') {
    super(message);
    this.name = 'NotPdfSourceError';
  }
}

export class ConfirmedPdfDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfirmedPdfDownloadError';
  }
}

export interface DownloadedPdf {
  bytes: Buffer;
  sha256: string;
  finalUrl: string;
  mimeType: string | null;
  filename: string | null;
}

export async function downloadPdf(rawUrl: string, options: PdfDownloadOptions): Promise<DownloadedPdf> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const guard = options.guard ?? guardSsrfResolved;
  const maxRedirects = options.maxRedirects ?? 10;
  let currentUrl = normaliseUrl(rawUrl);
  let response: Response | null = null;
  let confirmedPdf = false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`PDF download exceeded ${options.timeoutMs}ms`), options.timeoutMs);
  try {
    for (let redirects = 0; redirects <= maxRedirects; redirects++) {
      await guard(currentUrl);
      response = await fetchImpl(currentUrl, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'Accept': 'application/pdf,application/octet-stream;q=0.8,*/*;q=0.1' },
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      const location = response.headers.get('location');
      if (!location) throw new Error(`PDF redirect from ${currentUrl} has no Location header`);
      if (redirects === maxRedirects) throw new Error(`PDF download exceeded ${maxRedirects} redirects`);
      currentUrl = validateRedirectUrl(new URL(location, currentUrl).toString());
    }
    if (!response) throw new Error('PDF download returned no response');
    if (!response.ok) throw new Error(`PDF download returned HTTP ${response.status}`);
    const declaredLength = parseContentLength(response.headers.get('content-length'));
    if (!response.body) throw new Error('PDF response has no body');

    const reader = response.body.getReader();
    const tempDir = mkdtempSync(join(tmpdir(), 'packrat-pdf-'));
    const tempPath = join(tempDir, 'source.pdf');
    const descriptor = openSync(tempPath, 'w');
    const hash = createHash('sha256');
    let total = 0;
    let signature = Buffer.alloc(0);
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        total += value.byteLength;
        if (signature.byteLength < PDF_SIGNATURE.byteLength) {
          signature = Buffer.concat([signature, Buffer.from(value)]).subarray(0, PDF_SIGNATURE.byteLength);
          if (signature.byteLength === PDF_SIGNATURE.byteLength && !signature.equals(PDF_SIGNATURE)) {
            await reader.cancel();
            throw new NotPdfSourceError();
          }
          confirmedPdf = signature.byteLength === PDF_SIGNATURE.byteLength;
          if (confirmedPdf && declaredLength != null && declaredLength > options.maxBytes) {
            await reader.cancel();
            throw new ConfirmedPdfDownloadError(`PDF exceeds the ${options.maxBytes} byte limit (${declaredLength} bytes declared)`);
          }
        }
        if (total > options.maxBytes) {
          await reader.cancel();
          throw new ConfirmedPdfDownloadError(`PDF exceeds the ${options.maxBytes} byte limit`);
        }
        hash.update(value);
        writeSync(descriptor, value);
      }
      if (total < PDF_SIGNATURE.byteLength || !signature.equals(PDF_SIGNATURE)) throw new NotPdfSourceError();
      closeSync(descriptor);
      const bytes = readFileSync(tempPath);
      return {
        bytes,
        sha256: hash.digest('hex'),
        finalUrl: currentUrl,
        mimeType: response.headers.get('content-type')?.split(';', 1)[0]?.trim() || null,
        filename: responseFilename(response.headers.get('content-disposition'), currentUrl),
      };
    } finally {
      try { closeSync(descriptor); } catch {}
      reader.releaseLock();
      rmSync(tempDir, { recursive: true, force: true });
    }
  } catch (error: any) {
    if (controller.signal.aborted) {
      const message = `PDF download timed out after ${options.timeoutMs}ms`;
      if (confirmedPdf) throw new ConfirmedPdfDownloadError(message);
      throw new Error(message);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function validateRedirectUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`Unsupported PDF redirect scheme: ${url.protocol}`);
  if (url.username || url.password) throw new Error('PDF redirects containing embedded credentials are not allowed');
  return url.toString();
}

function parseContentLength(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) ? length : null;
}

function responseFilename(contentDisposition: string | null, url: string): string | null {
  if (contentDisposition) {
    const utf8 = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (utf8) {
      try { return sanitiseFilename(decodeURIComponent(utf8)); } catch { /* use fallback */ }
    }
    const quoted = contentDisposition.match(/filename="([^"]+)"/i)?.[1];
    const bare = contentDisposition.match(/filename=([^;\s]+)/i)?.[1];
    const headerName = quoted ?? bare;
    if (headerName) return sanitiseFilename(headerName);
  }
  try {
    const name = new URL(url).pathname.split('/').pop();
    return name ? sanitiseFilename(decodeURIComponent(name)) : null;
  } catch { return null; }
}

function sanitiseFilename(value: string): string | null {
  const name = value.replace(/[\\/\u0000-\u001f\u007f]/g, '_').trim().slice(0, 255);
  return name || null;
}
