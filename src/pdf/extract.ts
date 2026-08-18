export interface PdfExtractionLimits {
  timeoutMs: number;
  maxPages: number;
  maxTextBytes: number;
}

export interface PdfExtractionResult {
  status: 'succeeded' | 'failed' | 'timeout' | 'encrypted' | 'image_only';
  pageCount: number | null;
  title: string | null;
  text: string;
  textBytes: number;
  textTruncated: boolean;
  warnings: string[];
  error: string | null;
}

export const DEFAULT_PDF_EXTRACTION_LIMITS: PdfExtractionLimits = {
  timeoutMs: 60_000,
  maxPages: 1_000,
  maxTextBytes: 10 * 1024 * 1024,
};

/** Run PDF.js outside the application isolate and terminate it at the deadline. */
export async function extractPdf(
  bytes: Uint8Array,
  limits: PdfExtractionLimits = DEFAULT_PDF_EXTRACTION_LIMITS,
): Promise<PdfExtractionResult> {
  const worker = new Worker(new URL('./extract-worker.ts', import.meta.url).href, { type: 'module' });
  return await new Promise<PdfExtractionResult>((resolve) => {
    let settled = false;
    const finish = (result: PdfExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      resolve(result);
    };
    const timer = setTimeout(() => finish({
      status: 'timeout', pageCount: null, title: null, text: '', textBytes: 0,
      textTruncated: false,
      warnings: [`PDF text extraction exceeded ${limits.timeoutMs}ms`],
      error: `PDF text extraction timed out after ${limits.timeoutMs}ms`,
    }), limits.timeoutMs);
    worker.onmessage = (event: MessageEvent<PdfExtractionResult>) => finish(event.data);
    worker.onerror = (event: ErrorEvent) => finish({
      status: 'failed', pageCount: null, title: null, text: '', textBytes: 0,
      textTruncated: false, warnings: [], error: event.message || 'PDF extraction worker failed',
    });
    // Transfer ownership when the input is already a complete transferable
    // buffer. Otherwise copy only the addressed view, never an oversized
    // backing buffer.
    const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer
      ? bytes
      : bytes.slice();
    worker.postMessage({ bytes: transferable, maxPages: limits.maxPages, maxTextBytes: limits.maxTextBytes }, [transferable.buffer]);
  });
}
