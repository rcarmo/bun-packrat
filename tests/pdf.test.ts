import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { ConfirmedPdfDownloadError, downloadPdf, NotPdfSourceError } from '../src/pdf/download.js';
import { extractPdf } from '../src/pdf/extract.js';
import { parseSingleByteRange } from '../src/http/range.js';

function fixturePdf(text: string): Buffer {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const stream = `BT /F1 18 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index < offsets.length; index++) output += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

describe('bounded PDF download', () => {
  test('accepts signature-confirmed bytes and hashes them exactly', async () => {
    const pdf = fixturePdf('Downloaded Packrat PDF');
    const result = await downloadPdf('https://example.com/report', {
      maxBytes: 10_000, timeoutMs: 1_000,
      guard: async () => {},
      fetchImpl: async () => new Response(Uint8Array.from(pdf).buffer, { headers: {
        'content-type': 'text/html',
        'content-disposition': `attachment; filename*=UTF-8''report%20one.pdf`,
      }}),
    });
    expect(result.bytes).toEqual(pdf);
    expect(result.sha256).toBe(createHash('sha256').update(pdf).digest('hex'));
    expect(result.filename).toBe('report one.pdf');
    expect(result.mimeType).toBe('text/html');
  });

  test('rejects HTML even when MIME and extension claim PDF', async () => {
    await expect(downloadPdf('https://example.com/report.pdf', {
      maxBytes: 10_000, timeoutMs: 1_000, guard: async () => {},
      fetchImpl: async () => new Response('<html>not pdf</html>', { headers: { 'content-type': 'application/pdf' } }),
    })).rejects.toBeInstanceOf(NotPdfSourceError);
  });

  test('validates every redirect and enforces the size after confirming signature', async () => {
    const guarded: string[] = [];
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      return calls === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/report.pdf' } })
        : new Response(Uint8Array.from(Buffer.from('%PDF-' + 'x'.repeat(50))).buffer, { headers: { 'content-length': '55' } });
    };
    await expect(downloadPdf('https://example.com/start', {
      maxBytes: 20, timeoutMs: 1_000, fetchImpl,
      guard: async (url) => { guarded.push(url); },
    })).rejects.toBeInstanceOf(ConfirmedPdfDownloadError);
    expect(guarded).toEqual(['https://example.com/start', 'https://cdn.example.net/report.pdf']);
  });
});

describe('isolated PDF.js extraction', () => {
  test('extracts text in a worker within page and byte limits', async () => {
    const result = await extractPdf(fixturePdf('Hello Packrat PDF extraction'), {
      timeoutMs: 10_000, maxPages: 1_000, maxTextBytes: 10 * 1024 * 1024,
    });
    expect(result.status).toBe('succeeded');
    expect(result.pageCount).toBe(1);
    expect(result.text).toContain('Hello Packrat PDF extraction');
    expect(result.textTruncated).toBe(false);
  });

  test('retains a failed extraction result instead of throwing', async () => {
    const result = await extractPdf(Buffer.from('%PDF-invalid'), {
      timeoutMs: 10_000, maxPages: 1_000, maxTextBytes: 1024,
    });
    expect(['failed', 'encrypted', 'image_only']).toContain(result.status);
  });
});

describe('single HTTP byte ranges', () => {
  test('parses closed, open, and suffix ranges', () => {
    expect(parseSingleByteRange('bytes=0-4', 10)).toEqual([0, 4]);
    expect(parseSingleByteRange('bytes=5-', 10)).toEqual([5, 9]);
    expect(parseSingleByteRange('bytes=-3', 10)).toEqual([7, 9]);
    expect(parseSingleByteRange('bytes=8-99', 10)).toEqual([8, 9]);
  });

  test('rejects multiple and unsatisfiable ranges', () => {
    expect(parseSingleByteRange('bytes=0-1,3-4', 10)).toBeNull();
    expect(parseSingleByteRange('bytes=10-', 10)).toBeNull();
    expect(parseSingleByteRange('items=0-1', 10)).toBeNull();
  });
});
