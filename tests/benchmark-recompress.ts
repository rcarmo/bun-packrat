// Manual release-gate benchmark; deliberately excluded from bun test discovery.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fitOversizedMhtml, rewriteMhtmlRasterImages } from '../src/capture/recompress.js';
import { detectStoredCaptureFormat, renderMhtmlToHtml } from '../src/capture/canonical.js';

const paths = process.argv.slice(2);
if (!paths.length) throw new Error('Pass one or more image paths');
const boundary = '----PackratResourceBenchmark';
const lines = [
  'From: <Saved by Blink>',
  'Snapshot-Content-Location: https://example.com/benchmark',
  'MIME-Version: 1.0',
  `Content-Type: multipart/related; boundary="${boundary}"`,
  '',
  `--${boundary}`,
  'Content-Type: text/html',
  'Content-Location: https://example.com/benchmark',
  '',
  `<html><body>${paths.map((path) => `<img src="${basename(path)}">`).join('')}</body></html>`,
];
for (const path of paths) {
  const bytes = readFileSync(path);
  const contentType = path.toLowerCase().endsWith('.png') ? 'image/png' : path.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';
  lines.push(
    `--${boundary}`,
    `Content-Type: ${contentType}`,
    'Content-Transfer-Encoding: base64',
    `Content-Location: https://example.com/${basename(path)}`,
    '',
    bytes.toString('base64'),
  );
}
lines.push(`--${boundary}--`, '');
const raw = Buffer.from(lines.join('\r\n'));
const started = performance.now();
const colour = await rewriteMhtmlRasterImages(raw, 'colour');
const result = await fitOversizedMhtml(raw, colour.bytes.byteLength);
const html = renderMhtmlToHtml(result.bytes.toString('latin1'));
const rss = process.memoryUsage().rss;
console.log(JSON.stringify({
  images: paths.length,
  originalBytes: raw.byteLength,
  resultBytes: result.bytes.byteLength,
  pass: result.pass,
  replacedImages: result.replacedImages,
  elapsedMs: Math.round(performance.now() - started),
  rssBytes: rss,
  validFormat: detectStoredCaptureFormat(result.bytes),
  renderedImages: html.match(/data:image\/webp;base64,/g)?.length ?? 0,
}, null, 2));
