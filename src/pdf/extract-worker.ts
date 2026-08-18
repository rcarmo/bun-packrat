import { getDocument, PasswordResponses } from 'pdfjs-dist/legacy/build/pdf.mjs';

interface ExtractRequest {
  bytes: Uint8Array;
  maxPages: number;
  maxTextBytes: number;
}

interface ExtractResponse {
  status: 'succeeded' | 'failed' | 'encrypted' | 'image_only';
  pageCount: number | null;
  title: string | null;
  text: string;
  textBytes: number;
  textTruncated: boolean;
  warnings: string[];
  error: string | null;
}

self.onmessage = async (event: MessageEvent<ExtractRequest>) => {
  const { bytes, maxPages, maxTextBytes } = event.data;
  const response: ExtractResponse = {
    status: 'failed', pageCount: null, title: null, text: '', textBytes: 0,
    textTruncated: false, warnings: [], error: null,
  };
  let document: Awaited<ReturnType<typeof getDocument>['promise']> | null = null;
  try {
    const loadingTask = getDocument({
      data: bytes,
      isEvalSupported: false,
      useSystemFonts: true,
      stopAtErrors: false,
    });
    document = await loadingTask.promise;
    response.pageCount = document.numPages;
    if (document.numPages > maxPages) {
      response.warnings.push(`PDF has ${document.numPages} pages; text extraction stopped after ${maxPages}`);
    }
    try {
      const metadata = await document.getMetadata();
      const info = metadata.info as Record<string, unknown>;
      response.title = typeof info.Title === 'string' && info.Title.trim() ? info.Title.trim() : null;
    } catch (error: any) {
      response.warnings.push(`PDF metadata could not be read: ${String(error?.message ?? error).slice(0, 300)}`);
    }

    const textParts: string[] = [];
    let textBytes = 0;
    const pages = Math.min(document.numPages, maxPages);
    for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item: any) => typeof item?.str === 'string' ? item.str : '')
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      page.cleanup();
      if (!pageText) continue;
      const separator = textParts.length ? '\n\n' : '';
      const available = maxTextBytes - textBytes;
      const candidate = `${separator}${pageText}`;
      const candidateBytes = Buffer.byteLength(candidate, 'utf8');
      if (candidateBytes <= available) {
        textParts.push(candidate);
        textBytes += candidateBytes;
        continue;
      }
      if (available > 0) textParts.push(truncateUtf8(candidate, available));
      response.textTruncated = true;
      response.warnings.push(`Extracted PDF text reached the ${maxTextBytes} byte limit`);
      break;
    }
    response.text = textParts.join('');
    response.textBytes = Buffer.byteLength(response.text, 'utf8');
    response.status = response.text.trim() ? 'succeeded' : 'image_only';
    if (response.status === 'image_only') response.warnings.push('PDF contains no extractable text; OCR was not attempted');
  } catch (error: any) {
    if (error?.name === 'PasswordException' || error?.code === PasswordResponses.NEED_PASSWORD || error?.code === PasswordResponses.INCORRECT_PASSWORD) {
      response.status = 'encrypted';
      response.warnings.push('PDF is encrypted; no password was stored or attempted');
    } else {
      response.status = 'failed';
      response.error = String(error?.message ?? error).slice(0, 1000);
    }
  } finally {
    await document?.destroy().catch(() => {});
  }
  self.postMessage(response);
};

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}
