/**
 * bun-packrat — EPUB 3 export
 *
 * Adapted from rcarmo/bun-readlater-epub (src/epub/build.ts).
 * Builds a valid EPUB 3.0 ZIP from a stored packrat capture:
 *   1. Decompresses stored HTML
 *   2. Extracts data: URL images as EPUB assets
 *   3. Rewrites image references to relative OEBPS paths
 *   4. Sanitises HTML to valid XHTML for the article body
 *   5. Assembles content.opf, nav.xhtml, article.xhtml + assets
 *
 * Returns the EPUB bytes in memory — caller streams and discards.
 */

import { createHash } from 'crypto';
import { parseHTML } from 'linkedom';
import type { Database } from 'bun:sqlite';
import { getCaptureById, getCaptureHtml } from '../db/index.js';
import { slugify } from './html.js';

export interface EpubExportResult {
  epub: Uint8Array;
  filename: string;
  title: string;
}

interface EpubAsset {
  id: string;
  href: string;       // relative to OEBPS/
  mediaType: string;
  bytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// ZIP (pure Bun, no deps — same implementation as markdown.ts)
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; data: Uint8Array; compress?: boolean };

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date) {
  const year = Math.max(1980, d.getUTCFullYear());
  const dosTime = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | (Math.floor(d.getUTCSeconds() / 2) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0xf) << 5) | (d.getUTCDate() & 0x1f);
  return { dosDate, dosTime };
}

async function buildEpubZip(entries: ZipEntry[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const files: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);
    const method = 0; // store (uncompressed) — required for mimetype, safe for all

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, method, true);
    lv.setUint16(10, now.dosTime, true);
    lv.setUint16(12, now.dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(data, 30 + name.length);
    files.push(local);

    const c = new Uint8Array(46 + name.length);
    const cv = new DataView(c.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true); // general-purpose flags
    cv.setUint16(10, method, true);
    cv.setUint16(12, now.dosTime, true);
    cv.setUint16(14, now.dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    c.set(name, 46);
    central.push(c);
    offset += local.length;
  }

  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total = offset + centralSize + end.length;
  const out = new Uint8Array(total);
  let cur = 0;
  for (const p of files) { out.set(p, cur); cur += p.length; }
  for (const p of central) { out.set(p, cur); cur += p.length; }
  out.set(end, cur);
  return out;
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function normaliseToXhtml(fragment: string): string {
  // Self-close void HTML elements for XHTML compliance
  return fragment.replace(
    /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\s[^>]*?)?>/gi,
    (match, tag, attrs = '') => {
      if (/\/\s*>$/.test(match)) return match;
      return `<${tag}${attrs} />`;
    },
  );
}

// ---------------------------------------------------------------------------
// Content extraction from stored HTML
// ---------------------------------------------------------------------------

interface ParsedCapture {
  title: string;
  author: string | null;
  lang: string;
  bodyHtml: string;
  assets: EpubAsset[];
  coverAssetId: string | null;
}

function parseStoredHtml(htmlStr: string): ParsedCapture {
  const { document } = parseHTML(htmlStr);

  const title =
    document.querySelector('title')?.textContent?.trim() ??
    document.querySelector('h1')?.textContent?.trim() ??
    'Archived page';

  const author =
    document.querySelector('meta[name="packrat:author"]')?.getAttribute('content') ??
    null;

  const lang = document.querySelector('html')?.getAttribute('lang') ?? 'en';

  // Extract assets from the article content div (skip packrat-header)
  const contentDiv = document.querySelector('.packrat-content');
  const bodySource = contentDiv ?? document.body ?? document.documentElement;

  const assets: EpubAsset[] = [];
  let assetIdx = 0;

  // Extract data: URL images → EPUB assets, rewrite to relative paths
  bodySource.querySelectorAll('img[src]').forEach((img: any) => {
    const src = img.getAttribute('src') ?? '';
    if (!src.startsWith('data:')) return;

    const m = src.match(/^data:([^;]+);base64,(.+)$/s);
    if (!m) return;

    const mime = m[1].toLowerCase();
    const bytes = new Uint8Array(Buffer.from(m[2], 'base64'));
    const ext = mimeToExt(mime);
    const id = `img${assetIdx}`;
    const href = `assets/${id}.${ext}`;

    assets.push({ id, href, mediaType: mime, bytes });
    img.setAttribute('src', href);
    assetIdx++;
  });

  // Remove archive header from EPUB body
  bodySource.querySelector?.('.packrat-header')?.remove?.();

  const bodyHtml = bodySource.innerHTML ?? '';
  const coverAssetId = assets.find((asset) => asset.mediaType !== 'image/svg+xml')?.id ?? null;

  return { title, author, lang, bodyHtml, assets, coverAssetId };
}

function mimeToExt(mime: string): string {
  const m: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'image/avif': 'avif',
  };
  return m[mime] ?? 'bin';
}

// ---------------------------------------------------------------------------
// EPUB document builders
// ---------------------------------------------------------------------------

function buildContentOpf(
  parsed: ParsedCapture,
  sourceUrl: string,
  publishedAt: string | null,
  identifier: string,
): string {
  const modified = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const manifestAssets = parsed.assets
    .map((a) => `    <item id="${esc(a.id)}" href="${esc(a.href)}" media-type="${esc(a.mediaType)}"${a.id === parsed.coverAssetId ? ' properties="cover-image"' : ''} />`)
    .join('\n');

  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${esc(identifier)}</dc:identifier>
    <dc:title>${esc(parsed.title)}</dc:title>
    <dc:language>${esc(parsed.lang)}</dc:language>
    ${parsed.author ? `<dc:creator>${esc(parsed.author)}</dc:creator>` : ''}
    ${publishedAt ? `<dc:date>${esc(publishedAt)}</dc:date>` : ''}
    ${parsed.coverAssetId ? `<meta name="cover" content="${esc(parsed.coverAssetId)}" />` : ''}
    <meta property="dcterms:modified">${modified}</meta>
    <dc:source>${esc(sourceUrl)}</dc:source>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="article" href="article.xhtml" media-type="application/xhtml+xml" />
${manifestAssets}
  </manifest>
  <spine>
    <itemref idref="article" />
  </spine>
</package>`;
}

function buildNav(title: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <head><title>${esc(title)}</title></head>
  <body>
    <nav epub:type="toc" id="toc">
      <ol>
        <li><a href="article.xhtml">${esc(title)}</a></li>
      </ol>
    </nav>
  </body>
</html>`;
}

function buildArticleXhtml(parsed: ParsedCapture, sourceUrl: string): string {
  const body = normaliseToXhtml(parsed.bodyHtml);
  return `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head>
    <title>${esc(parsed.title)}</title>
    <meta charset="utf-8" />
    <style type="text/css">
      body { font-family: serif; line-height: 1.6; margin: 1em; }
      img { max-width: 100%; height: auto; }
      pre, code { font-family: monospace; font-size: 0.9em; }
      pre { background: #f5f5f5; padding: 0.8em; overflow-x: auto; }
      blockquote { border-left: 3px solid #ccc; margin-left: 1em; padding-left: 0.8em; }
      table { border-collapse: collapse; width: 100%; }
      td, th { border: 1px solid #ccc; padding: 0.3em 0.6em; }
    </style>
  </head>
  <body>
    <article>
      <h1>${esc(parsed.title)}</h1>
      ${parsed.author ? `<p><em>${esc(parsed.author)}</em></p>` : ''}
      ${body}
      <hr />
      <p><small><a href="${esc(sourceUrl)}">Original source</a></small></p>
    </article>
  </body>
</html>`;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export async function exportEpub(
  db: Database,
  captureId: number,
): Promise<EpubExportResult | null> {
  const meta = getCaptureById(db, captureId);
  if (!meta || meta.status !== 'succeeded') return null;

  const row = getCaptureHtml(db, captureId);
  if (!row?.html) return null;

  let htmlBytes: Buffer;
  if (row.compression === 'gzip') {
    htmlBytes = Buffer.from(Bun.gunzipSync(Buffer.from(row.html)));
  } else {
    htmlBytes = Buffer.from(row.html as unknown as Uint8Array);
  }

  const parsed = parseStoredHtml(htmlBytes.toString('utf-8'));
  const contentHash = createHash('sha256').update(parsed.bodyHtml).digest('hex');
  const identifier = `${meta.source_url}#${contentHash.slice(0, 12)}`;
  const enc = new TextEncoder();

  const entries: ZipEntry[] = [
    { name: 'mimetype', data: enc.encode('application/epub+zip'), compress: false },
    {
      name: 'META-INF/container.xml',
      data: enc.encode(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`),
    },
    {
      name: 'OEBPS/content.opf',
      data: enc.encode(buildContentOpf(parsed, meta.source_url, meta.captured_at, identifier)),
    },
    { name: 'OEBPS/nav.xhtml', data: enc.encode(buildNav(parsed.title)) },
    { name: 'OEBPS/article.xhtml', data: enc.encode(buildArticleXhtml(parsed, meta.source_url)) },
    ...parsed.assets.map((a) => ({ name: `OEBPS/${a.href}`, data: a.bytes })),
  ];

  const epub = await buildEpubZip(entries);
  const filename = slugify(parsed.title) + '.epub';

  return { epub, filename, title: parsed.title };
}
