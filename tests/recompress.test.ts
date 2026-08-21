import { describe, expect, test } from 'bun:test';
import { detectStoredCaptureFormat, renderMhtmlToHtml } from '../src/capture/canonical.js';
import {
  fitOversizedMhtml,
  rewriteMhtmlRasterImages,
  type RasterEncoder,
} from '../src/capture/recompress.js';

const BOUNDARY = '----PackratRecompressionFixture';
const REAL_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

function part(contentType: string, location: string, bytes: Buffer): string[] {
  return [
    `--${BOUNDARY}`,
    `Content-Type: ${contentType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Location: ${location}`,
    'X-Preserved: yes',
    '',
    bytes.toString('base64'),
  ];
}

function fixture(): Buffer {
  return Buffer.from([
    'From: <Saved by Blink>',
    'Snapshot-Content-Location: https://example.com/',
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://example.com/',
    '',
    '<!doctype html><html><body><img src=3D"one.png"><img src=3D"two.jpg"><img src=3D"three.webp"><img src=3D"keep.gif"><img src=3D"keep.svg"></body></html>',
    ...part('image/png', 'https://example.com/one.png', Buffer.alloc(180, 1)),
    ...part('image/jpeg', 'https://example.com/two.jpg', Buffer.alloc(160, 2)),
    ...part('image/webp', 'https://example.com/three.webp', Buffer.alloc(140, 3)),
    ...part('image/gif', 'https://example.com/keep.gif', Buffer.alloc(120, 4)),
    ...part('image/svg+xml', 'https://example.com/keep.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')),
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n'), 'utf8');
}

const encoder: RasterEncoder = async (bytes, options) => {
  const size = options.greyscale ? 12 : 48;
  return Buffer.alloc(size, bytes[0]);
};

describe('oversized MHTML raster fallback', () => {
  test('the native Bun.Image encoder produces valid WebP MIME data', async () => {
    const raw = Buffer.from([
      'From: <Saved by Blink>',
      `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
      '',
      `--${BOUNDARY}`,
      'Content-Type: text/html',
      'Content-Location: https://example.com/',
      '',
      '<html><body><img src="one.png"></body></html>',
      `--${BOUNDARY}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: base64',
      'Content-Location: https://example.com/one.png',
      '',
      Buffer.concat(Array.from({ length: 8 }, () => REAL_PNG)).toString('base64'),
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n'));
    const rewritten = await rewriteMhtmlRasterImages(raw, 'colour');
    expect(rewritten.replacedImages).toBe(1);
    expect(rewritten.bytes.toString('utf8')).toContain('Content-Type: image/webp');
    const html = renderMhtmlToHtml(rewritten.bytes.toString('utf8'));
    const data = html.match(/data:image\/webp;base64,([^"']+)/)?.[1];
    expect(data).toBeTruthy();
    expect(Buffer.from(data!, 'base64').subarray(0, 4).toString('ascii')).toBe('RIFF');
  });

  test('leaves an ordinary snapshot byte-exact and does not invoke the encoder', async () => {
    const raw = fixture();
    let calls = 0;
    const result = await fitOversizedMhtml(raw, raw.byteLength, {
      encode: async () => { calls++; return Buffer.alloc(1); },
    });
    expect(result.bytes).toEqual(raw);
    expect(result.pass).toBe('none');
    expect(result.warning).toBeNull();
    expect(calls).toBe(0);
  });

  test('accepts the colour quality-75 candidate when it fits', async () => {
    const raw = fixture();
    const colour = await rewriteMhtmlRasterImages(raw, 'colour', encoder);
    const calls: Array<{ greyscale: boolean; quality: number; contentType: string }> = [];
    const result = await fitOversizedMhtml(raw, colour.bytes.byteLength, {
      encode: async (bytes, options) => { calls.push(options); return encoder(bytes, options); },
    });
    expect(result.pass).toBe('colour');
    expect(result.bytes).toEqual(colour.bytes);
    expect(result.replacedImages).toBe(3);
    expect(result.warning).toBe('Oversized MHTML fitted after colour WebP quality 75 recompression (3 images replaced)');
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => !call.greyscale && call.quality === 75)).toBe(true);
    expect(detectStoredCaptureFormat(result.bytes)).toBe('mhtml');
    expect(renderMhtmlToHtml(result.bytes.toString('utf8'))).toContain('data:image/webp;base64,');
  });

  test('runs greyscale only after the colour candidate remains oversized', async () => {
    const raw = fixture();
    const colour = await rewriteMhtmlRasterImages(raw, 'colour', encoder);
    const grey = await rewriteMhtmlRasterImages(raw, 'greyscale', encoder);
    expect(grey.bytes.byteLength).toBeLessThan(colour.bytes.byteLength);
    const passes: boolean[] = [];
    const result = await fitOversizedMhtml(raw, grey.bytes.byteLength, {
      encode: async (bytes, options) => { passes.push(options.greyscale); return encoder(bytes, options); },
    });
    expect(result.pass).toBe('greyscale');
    expect(result.bytes).toEqual(grey.bytes);
    expect(passes).toEqual([false, false, false, true, true, true]);
    expect(result.warning).toContain('greyscale WebP quality 75');
  });

  test('preserves arbitrary non-UTF8 bytes in untouched MIME parts', async () => {
    const raw = Buffer.concat([
      fixture(),
    ]);
    const marker = Buffer.from([0x00, 0x80, 0x81, 0xfe, 0xff]);
    const text = raw.toString('latin1').replace(
      `--${BOUNDARY}--`,
      `--${BOUNDARY}\r\nContent-Type: application/octet-stream\r\nContent-Transfer-Encoding: binary\r\nContent-Location: https://example.com/raw.bin\r\n\r\n${marker.toString('latin1')}\r\n--${BOUNDARY}--`,
    );
    const binaryMhtml = Buffer.from(text, 'latin1');
    const rewritten = await rewriteMhtmlRasterImages(binaryMhtml, 'colour', encoder);
    expect(rewritten.bytes.includes(marker)).toBe(true);
  });

  test('rejects a smaller binary payload when base64 serialization makes the complete part larger', async () => {
    const body = Buffer.alloc(100, 0xa5);
    const raw = Buffer.from([
      'From: <Saved by Blink>',
      `Content-Type: multipart/related; boundary="${BOUNDARY}"`,
      '',
      `--${BOUNDARY}`,
      'Content-Type: text/html',
      '',
      '<html></html>',
      `--${BOUNDARY}`,
      'Content-Type: image/png',
      'Content-Transfer-Encoding: binary',
      'Content-Location: https://example.com/raw.png',
      '',
      body.toString('latin1'),
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n'), 'latin1');
    const rewritten = await rewriteMhtmlRasterImages(raw, 'colour', async () => Buffer.alloc(90, 1));
    expect(rewritten.replacedImages).toBe(0);
    expect(rewritten.bytes).toEqual(raw);
  });

  test('replaces only strictly smaller encodings and preserves ineligible parts and headers', async () => {
    const raw = fixture();
    const rewritten = await rewriteMhtmlRasterImages(raw, 'colour', async (bytes, options) => {
      if (options.contentType === 'image/png') return Buffer.alloc(bytes.byteLength + 1);
      return encoder(bytes, options);
    });
    expect(rewritten.replacedImages).toBe(2);
    const text = rewritten.bytes.toString('utf8');
    expect(text).toContain('Content-Type: image/png\r\n');
    expect(text).toContain(Buffer.alloc(180, 1).toString('base64'));
    expect(text).toContain('Content-Type: image/gif\r\n');
    expect(text).toContain('Content-Type: image/svg+xml\r\n');
    expect(text.match(/Content-Type: image\/webp/g)).toHaveLength(2);
    expect(text.match(/X-Preserved: yes/g)).toHaveLength(5);
    expect(text).toContain(`--${BOUNDARY}--`);
  });

  test('skips malformed eligible image parts without aborting other replacements', async () => {
    const raw = Buffer.from(fixture().toString('utf8').replace(Buffer.alloc(180, 1).toString('base64'), 'not-valid-base64%%%'));
    const rewritten = await rewriteMhtmlRasterImages(raw, 'colour', encoder);
    expect(rewritten.eligibleImages).toBe(3);
    expect(rewritten.skippedImages).toBe(1);
    expect(rewritten.replacedImages).toBe(2);
    expect(rewritten.bytes.toString('utf8')).toContain('not-valid-base64%%%');
  });

  test('fails without returning an oversized body when neither pass fits', async () => {
    const raw = fixture();
    await expect(fitOversizedMhtml(raw, 100, { encode: encoder })).rejects.toThrow(
      `Captured MHTML exceeds max size after image recompression`,
    );
  });
});
