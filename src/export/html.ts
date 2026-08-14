/**
 * bun-packrat — HTML export helper
 * Returns a safe, standalone HTML rendering derived from the canonical capture.
 */

import type { Database } from 'bun:sqlite';
import { getCaptureHtml, getCaptureById } from '../db/index.js';
import { renderStoredCaptureHtml } from '../capture/canonical.js';

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

  const htmlBytes = Buffer.from(renderStoredCaptureHtml(row), 'utf8');

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
