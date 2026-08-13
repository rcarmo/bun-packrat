/**
 * bun-packrat — HTML → Markdown converter + ZIP packager
 *
 * Converts a stored capture to Markdown text, extracts data: URL assets to
 * an assets/ directory, and packages everything as a ZIP.
 *
 * Output ZIP structure:
 *   article.md
 *   metadata.json
 *   assets/img-0.jpg   (extracted data: URL images)
 *   assets/img-1.png
 *   ...
 */

import { parseHTML } from 'linkedom';
import { createHash } from 'crypto';
import type { Database } from 'bun:sqlite';
import { getCaptureById, getCaptureHtml, getCaptureImageSources } from '../db/index.js';
import { slugify } from './html.js';

export interface MarkdownExportResult {
  zip: Uint8Array;
  filename: string;
}

// ---------------------------------------------------------------------------
// ZIP (same algorithm as bun-readlater-epub, no external deps)
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; data: Uint8Array };

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

function buildZip(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const files: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const entry of entries) {
    const name = enc.encode(entry.name);
    const data = entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + name.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(8, 0, true); // method: store
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
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true); // method: store
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
  for (const p of [...files, ...central, [end]].flat()) { out.set(p, cur); cur += p.length; }
  return out;
}

// ---------------------------------------------------------------------------
// HTML → Markdown walker
// ---------------------------------------------------------------------------

export function htmlToMarkdown(html: string, opts: { remoteImages?: Array<{ originalUrl: string | null; alt: string; title: string | null }> } = {}): { markdown: string; assets: Array<{ name: string; data: Uint8Array }> } {
  const { document } = parseHTML(html);
  const assets: Array<{ name: string; data: Uint8Array }> = [];
  let assetIndex = 0;
  let imageIndex = 0;

  function walk(node: any, depth = 0): string {
    if (!node) return '';

    if (node.nodeType === 3 /* TEXT */) {
      return node.textContent ?? '';
    }
    if (node.nodeType !== 1 /* ELEMENT */) return '';

    const tag = (node.tagName ?? '').toLowerCase();
    const children = [...(node.childNodes ?? [])];
    const inner = () => children.map((c: any) => walk(c, depth)).join('');

    switch (tag) {
      case 'h1': return `\n\n# ${inner().trim()}\n\n`;
      case 'h2': return `\n\n## ${inner().trim()}\n\n`;
      case 'h3': return `\n\n### ${inner().trim()}\n\n`;
      case 'h4': return `\n\n#### ${inner().trim()}\n\n`;
      case 'h5': return `\n\n##### ${inner().trim()}\n\n`;
      case 'h6': return `\n\n###### ${inner().trim()}\n\n`;
      case 'p': return `\n\n${inner().trim()}\n\n`;
      case 'br': return '  \n';
      case 'hr': return '\n\n---\n\n';
      case 'strong': case 'b': return `**${inner()}**`;
      case 'em': case 'i': return `*${inner()}*`;
      case 'del': case 's': return `~~${inner()}~~`;
      case 'code': {
        const parent = (node.parentNode?.tagName ?? '').toLowerCase();
        if (parent === 'pre') return inner();
        return `\`${inner()}\``;
      }
      case 'pre': {
        const code = node.querySelector?.('code');
        const lang = code?.className?.replace(/language-/, '') ?? '';
        const text = (code?.textContent ?? inner()).trim();
        return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
      }
      case 'blockquote': {
        const text = inner().trim().split('\n').map((l: string) => `> ${l}`).join('\n');
        return `\n\n${text}\n\n`;
      }
      case 'a': {
        const href = node.getAttribute('href') ?? '';
        const text = inner().trim();
        if (!text) return '';
        if (href && !href.startsWith('#')) return `[${text}](${formatMarkdownDestination(href)})`;
        return text;
      }
      case 'img': {
        const src = node.getAttribute('src') ?? '';
        const alt = node.getAttribute('alt') ?? '';
        const title = node.getAttribute('title') ?? '';
        const remote = opts.remoteImages?.[imageIndex++];
        if (opts.remoteImages) {
          const remoteAlt = escapeMarkdownText(remote?.alt ?? alt);
          if (!remote?.originalUrl) return remoteAlt ? `*[Image: ${remoteAlt}]*` : '';
          const remoteTitle = remote.title ? ` "${remote.title.replace(/"/g, '\\"')}"` : '';
          return `![${remoteAlt}](${formatMarkdownDestination(remote.originalUrl)}${remoteTitle})`;
        }
        if (src.startsWith('data:')) {
          // Extract data: URL asset
          const match = src.match(/^data:([^;]+);base64,(.+)$/s);
          if (match) {
            const mime = match[1];
            const ext = mimeToExt(mime);
            const name = `img-${assetIndex++}.${ext}`;
            const bytes = Buffer.from(match[2], 'base64');
            assets.push({ name, data: new Uint8Array(bytes) });
            return `![${escapeMarkdownText(alt)}](assets/${name}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
          }
        }
        if (src) return `![${escapeMarkdownText(alt)}](${formatMarkdownDestination(src)}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})`;
        return '';
      }
      case 'ul': {
        const items = children
          .filter((c: any) => (c.tagName ?? '').toLowerCase() === 'li')
          .map((li: any) => `- ${walk(li, depth).trim()}`)
          .join('\n');
        return `\n\n${items}\n\n`;
      }
      case 'ol': {
        const items = children
          .filter((c: any) => (c.tagName ?? '').toLowerCase() === 'li')
          .map((li: any, i: number) => `${i + 1}. ${walk(li, depth).trim()}`)
          .join('\n');
        return `\n\n${items}\n\n`;
      }
      case 'li': return inner();
      case 'table': return convertTable(node);
      case 'figure': return inner();
      case 'figcaption': return `\n*${inner().trim()}*\n`;
      case 'details': return inner();
      case 'summary': return `\n**${inner().trim()}**\n`;
      // Skip layout/nav wrappers but keep their content
      case 'div': case 'section': case 'article': case 'main':
      case 'header': case 'footer': case 'aside': case 'nav':
      case 'span': case 'abbr': case 'cite': case 'time':
      case 'small': case 'sub': case 'sup': case 'mark':
        return inner();
      // Skip metadata/control elements
      case 'head': case 'style': case 'script': case 'noscript':
      case 'meta': case 'link': case 'title':
        return '';
      default:
        return inner();
    }
  }

  function convertTable(table: any): string {
    const rows: string[][] = [];
    table.querySelectorAll?.('tr').forEach((tr: any) => {
      const cells = [...tr.querySelectorAll?.('td,th') ?? []].map((td: any) => escapeMarkdownTableCell(td.textContent?.trim() ?? ''));
      rows.push(cells);
    });
    if (rows.length === 0) return '';
    const header = `| ${rows[0].join(' | ')} |`;
    const sep = `| ${rows[0].map(() => '---').join(' | ')} |`;
    const body = rows.slice(1).map((r) => `| ${r.join(' | ')} |`).join('\n');
    return `\n\n${header}\n${sep}\n${body}\n\n`;
  }

  // Captures assembled by Packrat include an archive metadata header and a
  // semantic content wrapper. Reading/export modes should contain only the
  // captured document, not Packrat's synthetic chrome.
  const body = document.querySelector?.('.packrat-content') ?? document.body ?? document.documentElement;
  const markdown = walk(body)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { markdown, assets };
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\s*\n\s*/g, '<br>').replace(/\|/g, '\\|');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\\[\]*_`])/g, '\\$1');
}

function formatMarkdownDestination(value: string): string {
  // Keep ordinary URLs readable in raw Markdown. Angle-bracket destinations
  // are only needed when Markdown delimiters could otherwise be ambiguous.
  if (!/[()\s<>]/.test(value)) return value;
  return `<${value.replace(/\\/g, '\\\\').replace(/>/g, '\\>')}>`;
}

function mimeToExt(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
    'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
    'image/avif': 'avif', 'image/bmp': 'bmp',
  };
  return map[mime.toLowerCase()] ?? 'bin';
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

export async function renderRemoteMarkdown(db: Database, captureId: number): Promise<{ markdown: string; title: string } | null> {
  const meta = getCaptureById(db, captureId);
  if (!meta || meta.status !== 'succeeded') return null;
  const row = getCaptureHtml(db, captureId);
  if (!row?.html) return null;
  const htmlBytes = row.compression === 'gzip'
    ? Buffer.from(Bun.gunzipSync(Buffer.from(row.html)))
    : Buffer.from(row.html);
  const imageSources = getCaptureImageSources(db, captureId);
  const { markdown } = htmlToMarkdown(htmlBytes.toString('utf-8'), { remoteImages: imageSources });
  return { markdown, title: meta.title ?? `capture-${captureId}` };
}

export async function exportMarkdownZip(
  db: Database,
  captureId: number,
): Promise<MarkdownExportResult | null> {
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

  const htmlStr = htmlBytes.toString('utf-8');
  const { markdown, assets } = htmlToMarkdown(htmlStr);

  const enc = new TextEncoder();

  const metadata = {
    captureId,
    sourceUrl: meta.source_url,
    finalUrl: meta.final_url,
    title: meta.title,
    author: meta.author,
    siteName: meta.site_name,
    publishedAt: meta.published_at,
    capturedAt: meta.captured_at,
    mode: meta.mode,
    contentHash: meta.content_hash,
  };

  const entries: ZipEntry[] = [
    { name: 'article.md', data: enc.encode(markdown) },
    { name: 'metadata.json', data: enc.encode(JSON.stringify(metadata, null, 2)) },
    ...assets.map((a) => ({ name: `assets/${a.name}`, data: a.data })),
  ];

  const zip = buildZip(entries);
  const filename = slugify(meta.title ?? `capture-${captureId}`) + '.zip';

  return { zip, filename };
}
