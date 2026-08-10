/**
 * bun-packrat — HTML export helper
 * Returns the stored capture HTML with an optional export toolbar injected.
 */

import type { Database } from 'bun:sqlite';
import { getCaptureHtml, getCaptureById } from '../db/index.js';

export interface HtmlExportResult {
  html: Uint8Array;
  filename: string;
  title: string;
}

export async function exportHtml(
  db: Database,
  captureId: number,
): Promise<HtmlExportResult | null> {
  const meta = getCaptureById(db, captureId);
  if (!meta || meta.status !== 'succeeded') return null;

  const row = getCaptureHtml(db, captureId);
  if (!row?.html) return null;

  let htmlBytes: Buffer;
  if (row.compression === 'gzip') {
    htmlBytes = Buffer.from(Bun.gunzipSync(row.html as unknown as Uint8Array));
  } else {
    htmlBytes = Buffer.from(row.html as unknown as Uint8Array);
  }

  const filename = slugify(meta.title ?? `capture-${captureId}`) + '.html';

  return {
    html: htmlBytes,
    filename,
    title: meta.title ?? `capture-${captureId}`,
  };
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'capture';
}
