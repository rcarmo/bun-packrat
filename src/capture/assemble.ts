/**
 * bun-packrat — self-contained HTML assembler
 *
 * Takes the sanitised article or full-page content and wraps it in a complete
 * HTML document with:
 *  - archive header (source URL, final URL, capture time)
 *  - responsive screen CSS
 *  - print CSS
 *  - no external dependencies
 *
 * The result is the canonical capture stored in SQLite.
 */

import type { CaptureMode } from '../types.js';

export interface AssembleOptions {
  title: string | null;
  author: string | null;
  siteName: string | null;
  publishedAt: string | null;
  lang: string | null;
  sourceUrl: string;
  finalUrl: string;
  capturedAt: string;
  captureId?: number;
  mode: CaptureMode;
  captureTool?: string;
  /** SHA-256 of the sanitised semantic body before document assembly. */
  bodyContentHash?: string;
}

const ARCHIVE_STYLES = `
:root {
  color-scheme: light;
  --bg: #fff;
  --fg: #1a1a1a;
  --muted: #555;
  --border: #d0d0d0;
  --accent: #0057b7;
  --header-bg: #f5f5f5;
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-serif: Georgia, "Times New Roman", Times, serif;
  --font-mono: "SF Mono", ui-monospace, "Cascadia Mono", Menlo, monospace;
  --max-width: 720px;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --bg: #1a1a1a;
    --fg: #e8e8e8;
    --muted: #aaa;
    --border: #444;
    --header-bg: #242424;
    --accent: #5da9ff;
  }
}
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 16px; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: var(--font-serif);
  line-height: 1.65;
  -webkit-text-size-adjust: 100%;
}
.packrat-header {
  background: var(--header-bg);
  border-bottom: 1px solid var(--border);
  padding: 0.6rem 1rem;
  font-family: var(--font-sans);
  font-size: 0.78rem;
  color: var(--muted);
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 1.2rem;
  align-items: baseline;
}
.packrat-header a { color: var(--accent); word-break: break-all; }
.packrat-header code { overflow-wrap: anywhere; word-break: break-all; }
.packrat-header .label { font-weight: 600; }
.packrat-content {
  max-width: var(--max-width);
  min-width: 0;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}
.packrat-content h1,h2,h3,h4,h5,h6 {
  font-family: var(--font-sans);
  line-height: 1.25;
  margin: 1.5em 0 0.4em;
}
.packrat-content h1 { font-size: 1.9rem; margin-top: 0.5em; }
.packrat-content h2 { font-size: 1.45rem; }
.packrat-content h3 { font-size: 1.2rem; }
.packrat-content p { margin: 0 0 1em; }
.packrat-content img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 1em 0;
}
.packrat-content a { color: var(--accent); }
.packrat-content blockquote {
  border-left: 3px solid var(--border);
  margin: 1em 0 1em 1em;
  padding: 0.2em 0.8em;
  color: var(--muted);
  font-style: italic;
}
.packrat-content pre, .packrat-content code {
  font-family: var(--font-mono);
  font-size: 0.875em;
}
.packrat-content pre {
  max-width: 100%;
  background: var(--header-bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 0.8em 1em;
  overflow-x: auto;
}
.packrat-content code { background: var(--header-bg); border-radius: 3px; padding: 0.1em 0.3em; }
.packrat-content :not(pre) > code { overflow-wrap: anywhere; word-break: break-word; }
.packrat-content pre code { background: none; padding: 0; }
.packrat-content table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.9em; }
.packrat-content th, .packrat-content td { border: 1px solid var(--border); padding: 0.4em 0.7em; text-align: left; }
.packrat-content th { background: var(--header-bg); font-family: var(--font-sans); font-weight: 600; }
.packrat-content figure { margin: 1.5em 0; }
.packrat-content figcaption { font-size: 0.85em; color: var(--muted); text-align: center; margin-top: 0.4em; }
@media print {
  .packrat-header { border: 1px solid #ccc; background: #fff; color: #444; }
  .packrat-content { max-width: none; padding: 0; }
  a[href]::after { content: " (" attr(href) ")"; font-size: 0.75em; color: #666; }
}
`;

/**
 * Assemble the final self-contained HTML document.
 * `bodyHtml` is the sanitised article or full-page content.
 */
export function assembleHtml(bodyHtml: string, opts: AssembleOptions): string {
  const title = escapeHtml(opts.title ?? 'Archived page');
  const lang = opts.lang ?? 'en';
  const captured = opts.capturedAt;
  const mode = opts.mode;
  const tool = opts.captureTool ?? 'packrat/0.3.0';

  const authorPart = opts.author
    ? `<span class="label">By</span> ${escapeHtml(opts.author)}`
    : '';

  const sitePart = opts.siteName
    ? `<span class="label">Site</span> ${escapeHtml(opts.siteName)}`
    : '';

  const publishedPart = opts.publishedAt
    ? `<span class="label">Published</span> <time datetime="${escapeAttr(opts.publishedAt)}">${escapeHtml(opts.publishedAt)}</time>`
    : '';

  const headerItems = [
    `<span class="label">Archived</span> <time datetime="${escapeAttr(captured)}">${escapeHtml(captured)}</time>`,
    sitePart,
    authorPart,
    publishedPart,
    `<span class="label">Source</span> <a href="${escapeAttr(opts.sourceUrl)}" rel="noopener">${escapeHtml(opts.sourceUrl)}</a>`,
    opts.finalUrl !== opts.sourceUrl
      ? `<span class="label">Final URL</span> <a href="${escapeAttr(opts.finalUrl)}" rel="noopener">${escapeHtml(opts.finalUrl)}</a>`
      : '',
    `<span class="label">Mode</span> ${escapeHtml(mode)}`,
    `<span class="label">Tool</span> ${escapeHtml(tool)}`,
    opts.bodyContentHash ? `<span class="label">Content SHA-256</span> <code>${escapeHtml(opts.bodyContentHash)}</code>` : '',
  ]
    .filter(Boolean)
    .join('\n  ');

  return `<!DOCTYPE html>
<html lang="${escapeAttr(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta name="generator" content="${escapeAttr(tool)}">
<meta name="packrat:source-url" content="${escapeAttr(opts.sourceUrl)}">
<meta name="packrat:final-url" content="${escapeAttr(opts.finalUrl)}">
<meta name="packrat:captured-at" content="${escapeAttr(captured)}">
<meta name="packrat:mode" content="${escapeAttr(mode)}">
${opts.bodyContentHash ? `<meta name="packrat:content-hash" content="${escapeAttr(opts.bodyContentHash)}">` : ''}
${opts.author ? `<meta name="packrat:author" content="${escapeAttr(opts.author)}">` : ''}
${opts.siteName ? `<meta name="packrat:site-name" content="${escapeAttr(opts.siteName)}">` : ''}
${opts.publishedAt ? `<meta name="packrat:published-at" content="${escapeAttr(opts.publishedAt)}">` : ''}
${opts.captureId != null ? `<meta name="packrat:capture-id" content="${opts.captureId}">` : ''}
<style>
${ARCHIVE_STYLES}
</style>
</head>
<body>
<div class="packrat-header">
  ${headerItems}
</div>
<div class="packrat-content">
<h1>${title}</h1>
${bodyHtml}
</div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
