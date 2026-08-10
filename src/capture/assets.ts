/**
 * bun-packrat — asset inliner
 *
 * Fetches external images, fonts and stylesheets referenced in an HTML
 * document and rewrites them as data: URLs. Enforces per-asset size limits.
 * Only fetches from the public internet; file:// URLs are rejected.
 */

import { parseHTML } from 'linkedom';

export interface InlineAssetsOptions {
  /** Maximum bytes per asset (default 5 MB) */
  maxAssetBytes?: number;
  /** Fetch timeout per asset (ms, default 15 s) */
  assetTimeoutMs?: number;
  /** Absolute base URL for resolving relative references */
  baseUrl: string;
}

export interface InlineAssetsResult {
  html: string;
  inlined: number;
  skipped: number;
  warnings: string[];
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
  const { document } = parseHTML(html);

  let inlined = 0;
  let skipped = 0;
  const warnings: string[] = [];

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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), assetTimeoutMs);

      const resp = await fetch(resolved, {
        signal: controller.signal,
        headers: { 'User-Agent': 'packrat-archiver/0.1' },
      });
      clearTimeout(timer);

      if (!resp.ok) {
        warnings.push(`Asset fetch failed (${resp.status}): ${resolved}`);
        skipped++;
        return null;
      }

      const contentType = resp.headers.get('content-type') ?? 'application/octet-stream';
      const mimeType = contentType.split(';')[0].trim();

      // Only inline safe asset types
      if (!isSafeAssetMime(mimeType)) {
        warnings.push(`Skipped asset with unsafe MIME type ${mimeType}: ${resolved}`);
        skipped++;
        return null;
      }

      const buf = await resp.arrayBuffer();

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

  // img[src] and img[srcset] → inline first src only
  document.querySelectorAll('img[src]').forEach((el) => {
    const src = el.getAttribute('src');
    if (src && !src.startsWith('data:')) tasks.push({ el: el as Element, attr: 'src', src });
  });

  // source[src]
  document.querySelectorAll('source[src]').forEach((el) => {
    const src = el.getAttribute('src');
    if (src && !src.startsWith('data:')) tasks.push({ el: el as Element, attr: 'src', src });
  });

  // link[rel=stylesheet]
  document.querySelectorAll('link[rel~="stylesheet"]').forEach((el) => {
    const href = el.getAttribute('href');
    if (href && !href.startsWith('data:')) tasks.push({ el: el as Element, attr: 'href', src: href });
  });

  // Process in parallel (bounded by Promise.allSettled)
  const results = await Promise.allSettled(
    tasks.map(async (task) => {
      const dataUrl = await fetchAsDataUrl(task.src);
      if (dataUrl) {
        task.el.setAttribute(task.attr, dataUrl);
      }
    }),
  );

  // Count any unexpected rejections
  for (const r of results) {
    if (r.status === 'rejected') {
      warnings.push(`Unexpected inlining error: ${r.reason}`);
    }
  }

  return {
    html: document.toString(),
    inlined,
    skipped,
    warnings,
  };
}

function isSafeAssetMime(mime: string): boolean {
  return (
    mime.startsWith('image/') ||
    mime.startsWith('font/') ||
    mime === 'application/font-woff' ||
    mime === 'application/font-woff2' ||
    mime === 'application/x-font-ttf' ||
    mime === 'application/x-font-opentype' ||
    mime === 'text/css'
  );
}
