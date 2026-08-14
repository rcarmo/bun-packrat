import { parseHTML } from 'linkedom';
import { extractContent } from './extract.js';
import { sanitizeHtml } from './sanitize.js';

export type StoredCaptureFormat = 'html' | 'mhtml';

type StoredBody = { html: Uint8Array | null; compression: string };

type MimePart = {
  contentType: string;
  location: string | null;
  contentId: string | null;
  bytes: Buffer;
};

type ParsedMhtml = {
  rootLocation: string;
  rootHtml: string;
  parts: MimePart[];
};

export function readStoredCaptureBytes(row: StoredBody): Buffer {
  if (!row.html) throw new Error('Capture body is missing');
  return row.compression === 'gzip'
    ? Buffer.from(Bun.gunzipSync(Buffer.from(row.html)))
    : Buffer.from(row.html);
}

export function detectStoredCaptureFormat(bytes: Uint8Array): StoredCaptureFormat {
  const prefix = Buffer.from(bytes).subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b|<\?xml\b)/i.test(prefix)) return 'html';
  const headerEnd = findHeaderEnd(prefix);
  const headers = parseHeaders(headerEnd < 0 ? prefix : prefix.slice(0, headerEnd));
  if (/^multipart\/related\b/i.test(headers.get('content-type') ?? '')) return 'mhtml';
  throw new Error('Stored capture is neither HTML nor Chromium MHTML');
}

/** Return safe, standalone HTML for browser rendering and HTML/PDF export. */
export function renderStoredCaptureHtml(row: StoredBody): string {
  const bytes = readStoredCaptureBytes(row);
  if (detectStoredCaptureFormat(bytes) === 'html') return bytes.toString('utf8');
  return renderMhtmlToHtml(bytes.toString('utf8'));
}

/** Return an article-oriented document for Markdown and EPUB derivation. */
export function deriveStoredArticleHtml(row: StoredBody, baseUrl: string): string {
  const bytes = readStoredCaptureBytes(row);
  if (detectStoredCaptureFormat(bytes) === 'html') return bytes.toString('utf8');

  const fullPage = renderMhtmlToHtml(bytes.toString('utf8'));
  const extracted = extractContent(fullPage, baseUrl);
  const source = extracted.articleHtml ?? parseHTML(fullPage).document.body?.innerHTML ?? fullPage;
  // Sanitise the fragment inside a complete document. linkedom otherwise adds
  // synthetic head/body children to a fragment root, which can leak nested
  // document elements into EPUB and Markdown derivations.
  const wrapped = `<!doctype html><html><head></head><body><div id="packrat-derived-root">${source}</div></body></html>`;
  const { html } = sanitizeHtml(wrapped);
  const { document } = parseHTML(html);
  const body = document.querySelector('#packrat-derived-root')?.innerHTML?.trim()
    ?? document.body?.innerHTML?.trim()
    ?? '';
  return `<!doctype html><html lang="${escapeAttr(extracted.lang ?? 'en')}"><head><meta charset="utf-8"><title>${escapeHtml(extracted.title ?? 'Archived page')}</title></head><body><div class="packrat-content">${body}</div></body></html>`;
}

export function renderMhtmlToHtml(raw: string): string {
  const parsed = parseMhtml(raw);
  const resources = buildResourceMap(parsed);
  const { document } = parseHTML(parsed.rootHtml);

  document.querySelectorAll('link[rel~="stylesheet" i]').forEach((link) => {
    const href = link.getAttribute('href') ?? '';
    const part = findResource(resources, href, parsed.rootLocation);
    if (part?.contentType === 'text/css') {
      const style = document.createElement('style');
      style.textContent = rewriteCss(decodeTextPart(part), part.location ?? parsed.rootLocation, resources);
      link.parentNode?.insertBefore(style, link);
    }
    link.remove();
  });
  document.querySelectorAll('link').forEach((link) => link.remove());

  document.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteCss(style.textContent ?? '', parsed.rootLocation, resources);
  });
  const containmentStyle = document.createElement('style');
  containmentStyle.textContent = 'html,body{max-width:100%;overflow-x:hidden}img,video,canvas,svg{max-width:100%;height:auto}pre{max-width:100%;overflow-x:auto}:not(pre)>code{overflow-wrap:anywhere;word-break:break-word}table{max-width:100%}';
  const head = document.head ?? document.documentElement;
  head.appendChild(containmentStyle);

  // The HTTP routes also set CSP headers, but exports are often opened from
  // disk. Replace source policies with a restrictive embedded policy so the
  // standalone document remains offline even outside Packrat.
  document.querySelectorAll('meta[http-equiv]').forEach((meta) => {
    const directive = (meta.getAttribute('http-equiv') ?? '').trim().toLowerCase();
    if (directive === 'refresh' || directive === 'content-security-policy') meta.remove();
  });
  const cspMeta = document.createElement('meta');
  cspMeta.setAttribute('http-equiv', 'Content-Security-Policy');
  cspMeta.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  head.insertBefore(cspMeta, head.firstChild);

  document.querySelectorAll('[style]').forEach((element) => {
    const style = element.getAttribute('style');
    if (style != null) element.setAttribute('style', rewriteCss(style, parsed.rootLocation, resources));
  });

  document.querySelectorAll('img[src]').forEach((image) => {
    const src = image.getAttribute('src') ?? '';
    const part = findResource(resources, src, parsed.rootLocation);
    const dataUrl = part ? resourceDataUrl(part) : safeExistingDataUrl(src);
    if (dataUrl) image.setAttribute('src', dataUrl);
    else image.removeAttribute('src');
    image.removeAttribute('srcset');
  });
  document.querySelectorAll('[srcset]').forEach((element) => element.removeAttribute('srcset'));
  document.querySelectorAll('source').forEach((source) => source.remove());

  sanitiseRenderedDocument(document, parsed.rootLocation, resources);
  return '<!doctype html>\n' + document.toString().replace(/^<!doctype[^>]*>\s*/i, '');
}

function parseMhtml(raw: string): ParsedMhtml {
  const headerEnd = findHeaderEnd(raw);
  if (headerEnd < 0) throw new Error('MHTML header is incomplete');
  const topHeaders = parseHeaders(raw.slice(0, headerEnd));
  const contentType = topHeaders.get('content-type') ?? '';
  const boundary = getHeaderParameter(contentType, 'boundary');
  if (!/^multipart\/related\b/i.test(contentType) || !boundary) throw new Error('MHTML multipart boundary is missing');

  const rootLocation = topHeaders.get('snapshot-content-location') ?? '';
  const segments = raw.slice(headerEnd + headerSeparatorLength(raw, headerEnd)).split(`--${boundary}`);
  const parts: MimePart[] = [];
  for (const segmentValue of segments.slice(1)) {
    let segment = segmentValue.replace(/^\r?\n/, '');
    if (segment.startsWith('--')) break;
    segment = segment.replace(/\r?\n$/, '');
    const partHeaderEnd = findHeaderEnd(segment);
    if (partHeaderEnd < 0) continue;
    const headers = parseHeaders(segment.slice(0, partHeaderEnd));
    const body = segment.slice(partHeaderEnd + headerSeparatorLength(segment, partHeaderEnd));
    const partTypeHeader = headers.get('content-type') ?? 'application/octet-stream';
    const partType = partTypeHeader.split(';', 1)[0].trim().toLowerCase();
    const encoding = (headers.get('content-transfer-encoding') ?? '8bit').trim().toLowerCase();
    const bytes = decodeTransfer(body, encoding);
    parts.push({
      contentType: partType,
      location: headers.get('content-location') ?? null,
      contentId: headers.get('content-id')?.replace(/^<|>$/g, '') ?? null,
      bytes,
    });
  }

  const root = parts.find((part) => part.contentType === 'text/html' && sameResource(part.location, rootLocation))
    ?? parts.find((part) => part.contentType === 'text/html');
  if (!root) throw new Error('MHTML has no HTML root part');
  const effectiveRoot = root.location ?? rootLocation;
  return { rootLocation: effectiveRoot, rootHtml: decodeTextPart(root), parts };
}

function buildResourceMap(parsed: ParsedMhtml): Map<string, MimePart> {
  const resources = new Map<string, MimePart>();
  for (const part of parsed.parts) {
    if (part.location) {
      resources.set(part.location, part);
      try { resources.set(new URL(part.location, parsed.rootLocation).toString(), part); } catch {}
    }
    if (part.contentId) resources.set(`cid:${part.contentId}`, part);
  }
  return resources;
}

function findResource(resources: Map<string, MimePart>, value: string, base: string): MimePart | null {
  if (!value) return null;
  const direct = resources.get(value);
  if (direct) return direct;
  try {
    const resolved = new URL(value, base);
    const exact = resources.get(resolved.toString());
    if (exact) return exact;
    resolved.hash = '';
    return resources.get(resolved.toString()) ?? null;
  } catch {
    return null;
  }
}

function rewriteCss(css: string, base: string, resources: Map<string, MimePart>): string {
  let safe = css.replace(/@import\s+(?:url\([^)]*\)|["'][^"']*["'])[^;]*;?/gi, '');
  safe = safe.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (_match, _quote, rawUrl) => {
    const value = String(rawUrl).trim();
    if (!value || value.startsWith('#')) return `url("${escapeCssString(value)}")`;
    const existing = safeExistingDataUrl(value);
    if (existing) return `url("${escapeCssString(existing)}")`;
    const part = findResource(resources, value, base);
    const dataUrl = part ? resourceDataUrl(part) : null;
    return dataUrl ? `url("${escapeCssString(dataUrl)}")` : 'url("")';
  });
  return safe
    .replace(/expression\s*\([^)]*\)/gi, '')
    .replace(/(?:behavior|-moz-binding)\s*:[^;}]*/gi, '');
}

function sanitiseRenderedDocument(document: Document, base: string, resources: Map<string, MimePart>): void {
  for (const selector of ['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'canvas', 'video', 'audio', 'track', 'template', 'slot', 'base']) {
    document.querySelectorAll(selector).forEach((element) => element.remove());
  }
  document.querySelectorAll('form').forEach((form) => unwrap(form));
  for (const selector of ['input', 'button', 'select', 'textarea', 'fieldset', 'legend']) {
    document.querySelectorAll(selector).forEach((element) => element.remove());
  }
  document.querySelectorAll('*').forEach((element) => {
    for (const attribute of Array.from(element.attributes ?? [])) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value ?? '';
      if (name.startsWith('on') || ['srcdoc', 'nonce', 'integrity', 'crossorigin', 'autofocus', 'contenteditable'].includes(name)) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style') {
        element.setAttribute('style', rewriteCss(value, base, resources));
        continue;
      }
      if (name === 'href') {
        if (element.tagName.toLowerCase() !== 'a') {
          element.removeAttribute(attribute.name);
          continue;
        }
        const safe = normaliseNavigationHref(value, base);
        element.setAttribute('href', safe ?? '#');
        element.setAttribute('rel', 'noopener noreferrer');
        continue;
      }
      if (['src', 'srcset', 'poster', 'background', 'action', 'formaction', 'xlink:href'].includes(name)) {
        if (name === 'src' && element.tagName.toLowerCase() === 'img' && safeExistingDataUrl(value)) continue;
        element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === 'img') {
      element.setAttribute('loading', 'eager');
      element.setAttribute('decoding', 'async');
    }
  });
}

function normaliseNavigationHref(value: string, base: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#') || /^(?:mailto|tel):/i.test(trimmed)) return trimmed;
  try {
    const resolved = new URL(trimmed, base);
    return /^https?:$/.test(resolved.protocol) ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function resourceDataUrl(part: MimePart): string | null {
  if (!/^(?:image\/(?:avif|bmp|gif|jpeg|jpg|png|webp|x-icon)|font\/(?:otf|ttf|woff|woff2)|application\/(?:font-woff|vnd\.ms-fontobject|x-font-ttf|x-font-opentype))$/i.test(part.contentType)) return null;
  return `data:${part.contentType};base64,${part.bytes.toString('base64')}`;
}

function safeExistingDataUrl(value: string): string | null {
  return /^data:(?:image\/(?:avif|bmp|gif|jpeg|jpg|png|webp|x-icon)|font\/(?:otf|ttf|woff|woff2)|application\/(?:font-woff|vnd\.ms-fontobject|x-font-ttf|x-font-opentype));base64,/i.test(value) ? value : null;
}

function decodeTransfer(body: string, encoding: string): Buffer {
  if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64');
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(body);
  return Buffer.from(body, 'utf8');
}

function decodeQuotedPrintable(value: string): Buffer {
  const source = value.replace(/=\r?\n/g, '');
  const chunks: Buffer[] = [];
  let plain = '';
  const flush = () => { if (plain) { chunks.push(Buffer.from(plain, 'utf8')); plain = ''; } };
  for (let index = 0; index < source.length; index++) {
    if (source[index] === '=' && /^[0-9a-f]{2}$/i.test(source.slice(index + 1, index + 3))) {
      flush();
      chunks.push(Buffer.from([Number.parseInt(source.slice(index + 1, index + 3), 16)]));
      index += 2;
    } else {
      plain += source[index];
    }
  }
  flush();
  return Buffer.concat(chunks);
}

function decodeTextPart(part: MimePart): string {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(part.bytes); }
  catch { return part.bytes.toString('utf8'); }
}

function parseHeaders(raw: string): Map<string, string> {
  const unfolded = raw.replace(/\r?\n[\t ]+/g, ' ');
  const headers = new Map<string, string>();
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!headers.has(name)) headers.set(name, value);
  }
  return headers;
}

function getHeaderParameter(value: string, name: string): string | null {
  const match = value.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]+)"|([^;\\s]+))`, 'i'));
  return match?.[1] ?? match?.[2] ?? null;
}

function findHeaderEnd(value: string): number {
  const crlf = value.indexOf('\r\n\r\n');
  const lf = value.indexOf('\n\n');
  if (crlf < 0) return lf;
  if (lf < 0) return crlf;
  return Math.min(crlf, lf);
}

function headerSeparatorLength(value: string, at: number): number {
  return value.startsWith('\r\n\r\n', at) ? 4 : 2;
}

function sameResource(a: string | null, b: string): boolean {
  if (!a || !b) return false;
  try { return new URL(a, b).toString() === new URL(b).toString(); }
  catch { return a === b; }
}

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  for (const child of Array.from(element.childNodes)) parent.insertBefore(child, element);
  element.remove();
}

function escapeCssString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
