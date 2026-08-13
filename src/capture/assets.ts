/**
 * bun-packrat — asset inliner
 *
 * Fetches external images, fonts and stylesheets referenced in an HTML
 * document and rewrites them as data: URLs. Enforces per-asset size limits.
 * Only fetches from the public internet; file:// URLs are rejected.
 */

import { parseHTML } from 'linkedom';
import { guardSsrfResolved } from './url.js';

export interface InlineAssetsOptions {
  /** Maximum bytes per asset (default 5 MB) */
  maxAssetBytes?: number;
  /** Fetch timeout per asset (ms, default 15 s) */
  assetTimeoutMs?: number;
  /** Absolute base URL for resolving relative references */
  baseUrl: string;
  /** Maximum simultaneous asset fetches (default 6) */
  concurrency?: number;
}

export interface ImageSourceRecord {
  order: number;
  originalUrl: string | null;
  alt: string;
  title: string | null;
  width: number | null;
  height: number | null;
}

export interface InlineAssetsResult {
  html: string;
  inlined: number;
  skipped: number;
  warnings: string[];
  imageSources: ImageSourceRecord[];
}

/**
 * Inline external assets in-place on a document parsed from `html`.
 * Returns the serialised HTML with all fetchable assets replaced by data: URLs.
 */
export async function inlineAssets(
  html: string,
  opts: InlineAssetsOptions,
): Promise<InlineAssetsResult> {
  const maxAssetBytes = opts.maxAssetBytes ?? 5 * 1024 * 1024;
  const assetTimeoutMs = opts.assetTimeoutMs ?? 15_000;
  const concurrency = Math.max(1, Math.min(16, opts.concurrency ?? 6));
  const { document } = parseHTML(html);

  let inlined = 0;
  let skipped = 0;
  const warnings: string[] = [];
  const imageSources: ImageSourceRecord[] = [];

  /** Resolve a possibly-relative URL against the page base */
  function resolve(src: string): string | null {
    try {
      return new URL(src, opts.baseUrl).toString();
    } catch {
      return null;
    }
  }

  /** Fetch an asset and return it as a base64 data: URL, or null on error */
  async function fetchAsDataUrl(src: string): Promise<string | null> {
    const resolved = resolve(src);
    if (!resolved) {
      warnings.push(`Could not resolve asset URL: ${src}`);
      skipped++;
      return null;
    }

    // Only fetch http(s)
    if (!resolved.startsWith('http://') && !resolved.startsWith('https://')) {
      skipped++;
      return null;
    }

    // Already a data URL — pass through
    if (src.startsWith('data:')) return src;

    try {
      await guardSsrfResolved(resolved);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), assetTimeoutMs);

      let resp: Response;
      try {
        resp = await fetchWithSafeRedirects(resolved, controller.signal);
      } finally {
        clearTimeout(timer);
      }

      if (!resp.ok) {
        warnings.push(`Asset fetch failed (${resp.status}): ${resolved}`);
        skipped++;
        return null;
      }

      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      const mimeType = contentType.split(';')[0].trim().toLowerCase();
      const contentLength = Number(resp.headers.get('content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > maxAssetBytes) {
        resp.body?.cancel().catch(() => {});
        warnings.push(
          `Asset too large (${contentLength} bytes, limit ${maxAssetBytes}): ${resolved}`,
        );
        skipped++;
        return null;
      }

      // Only inline safe asset types
      if (!isSafeAssetMime(mimeType)) {
        warnings.push(`Skipped asset with unsafe MIME type ${mimeType}: ${resolved}`);
        skipped++;
        return null;
      }

      const buf = await readResponseLimited(resp, maxAssetBytes);

      if (!buf) {
        warnings.push(`Asset exceeded size limit (${maxAssetBytes} bytes): ${resolved}`);
        skipped++;
        return null;
      }

      if (buf.byteLength > maxAssetBytes) {
        warnings.push(
          `Asset too large (${buf.byteLength} bytes, limit ${maxAssetBytes}): ${resolved}`,
        );
        skipped++;
        return null;
      }

      const b64 = Buffer.from(buf).toString('base64');
      inlined++;
      return `data:${mimeType};base64,${b64}`;
    } catch (err: any) {
      warnings.push(`Asset fetch error for ${resolved}: ${err?.message ?? err}`);
      skipped++;
      return null;
    }
  }

  /** Collect all (element, attrName, value) tuples to process */
  const tasks: Array<{
    el: Element;
    attr: string;
    src: string;
  }> = [];

  // Preserve ordinary navigation while making surviving links independent of
  // the archived document's serving URL.
  document.querySelectorAll('a[href]').forEach((el) => {
    const href = el.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return;
    const absolute = resolve(href);
    if (absolute?.startsWith('http://') || absolute?.startsWith('https://')) el.setAttribute('href', absolute);
  });

  // img[src] and img[srcset] → inline first src only. Remove obvious tracking
  // pixels before downloading them.
  document.querySelectorAll('img').forEach((el, order) => {
    const width = Number(el.getAttribute('width') ?? NaN);
    const height = Number(el.getAttribute('height') ?? NaN);
    if ((Number.isFinite(width) && width <= 2) || (Number.isFinite(height) && height <= 2)) {
      el.remove();
      warnings.push('Removed probable tracking pixel');
      skipped++;
      return;
    }
    const src = chooseImageSource(el as Element, Number.isFinite(width) ? width : null);
    const originalUrl = src ? resolve(src) : null;
    const validOriginal = originalUrl?.startsWith('http://') || originalUrl?.startsWith('https://')
      ? originalUrl : null;
    imageSources.push({
      order,
      originalUrl: validOriginal,
      alt: el.getAttribute('alt') ?? '',
      title: el.getAttribute('title'),
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    });
    if (!validOriginal) {
      warnings.push(`Image ${order + 1} has no valid original URL; Markdown view will use alt text`);
    }
    if (src && !src.startsWith('data:')) tasks.push({ el: el as Element, attr: 'src', src });
  });

  // Responsive candidates and external stylesheets are deliberately not
  // fetched here. The sanitiser removes source/srcset/link/style dependencies
  // and the inlined img[src] remains the canonical fallback.

  // Process with bounded concurrency to prevent pages with thousands of
  // images from exhausting sockets or memory.
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        const dataUrl = await fetchAsDataUrl(task.src);
        if (dataUrl) task.el.setAttribute(task.attr, dataUrl);
      } catch (err: any) {
        warnings.push(`Unexpected inlining error: ${err?.message ?? err}`);
      }
    }
  });
  await Promise.all(workers);

  return {
    html: document.toString(),
    inlined,
    skipped,
    warnings,
    imageSources,
  };
}

function chooseImageSource(el: Element, displayWidth: number | null): string | null {
  const srcset = el.getAttribute('srcset');
  if (srcset) {
    // Candidate URLs may contain commas (for example Substack transforms).
    // A delimiter comma is the one after an optional w/x descriptor. Accept a
    // descriptorless candidate as the valid 1x fallback too.
    const candidates: Array<{ url: string; width: number | null; density: number }> = [];
    const described = /(?:^|,\s*)(\S+)\s+(\d+(?:\.\d+)?)(w|x)(?=\s*,|\s*$)/g;
    for (const match of srcset.matchAll(described)) {
      const amount = Number.parseFloat(match[2]);
      candidates.push({ url: match[1], width: match[3] === 'w' ? amount : null, density: match[3] === 'x' ? amount : 1 });
    }
    // Descriptorless candidates are valid 1x candidates. Only use this path
    // when there are no described candidates, preserving comma-bearing URLs.
    if (!candidates.length) {
      for (const value of srcset.split(/,\s+/)) {
        const url = value.trim();
        if (url && !/\s/.test(url)) candidates.push({ url, width: null, density: 1 });
      }
    }
    if (candidates.length) {
      const widthCandidates = candidates.filter((candidate) => candidate.width !== null);
      if (widthCandidates.length) {
        widthCandidates.sort((a, b) => (a.width! - b.width!));
        return (displayWidth
          ? widthCandidates.find((candidate) => candidate.width! >= displayWidth)
          : widthCandidates[widthCandidates.length - 1])?.url ?? widthCandidates[widthCandidates.length - 1].url;
      }
      candidates.sort((a, b) => b.density - a.density);
      return candidates[0].url;
    }
  }
  return el.getAttribute('src');
}

async function fetchWithSafeRedirects(initialUrl: string, signal: AbortSignal): Promise<Response> {
  let current = initialUrl;
  for (let redirect = 0; redirect <= 5; redirect++) {
    await guardSsrfResolved(current);
    const resp = await fetch(current, {
      signal,
      redirect: 'manual',
      headers: { 'User-Agent': 'packrat-archiver/0.1' },
    });
    if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
    const location = resp.headers.get('location');
    await resp.body?.cancel().catch(() => {});
    if (!location) throw new Error(`Asset redirect has no Location header: ${current}`);
    current = new URL(location, current).toString();
  }
  throw new Error(`Asset exceeded redirect limit: ${initialUrl}`);
}

async function readResponseLimited(resp: Response, maxBytes: number): Promise<ArrayBuffer | null> {
  if (!resp.body) return new ArrayBuffer(0);
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

function isSafeAssetMime(mime: string): boolean {
  return new Set([
    'image/avif', 'image/bmp', 'image/gif', 'image/jpeg', 'image/png',
    'image/webp', 'image/x-icon',
  ]).has(mime);
}
