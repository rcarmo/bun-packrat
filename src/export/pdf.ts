/**
 * bun-packrat — on-demand PDF export via Playwright
 *
 * Renders the stored capture HTML through Playwright's print CSS path,
 * streams the PDF to the caller, then deletes the temp file.
 * No PDF is retained after the response.
 */

import { chromium } from 'playwright';
import { mkdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { Database } from 'bun:sqlite';
import { getCaptureById, getCaptureHtml } from '../db/index.js';
import { slugify } from './html.js';
import { findChromiumExecutable } from '../capture/pipeline.js';

export interface PdfExportResult {
  pdf: Uint8Array;
  filename: string;
}

export async function exportPdf(
  db: Database,
  captureId: number,
  browsersPath: string,
  captureTimeoutMs = 60_000,
): Promise<PdfExportResult | null> {
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

  // Write HTML to a temp file for Playwright to load via file:// URL
  const tmpDir = join(tmpdir(), 'packrat-pdf');
  mkdirSync(tmpDir, { recursive: true });
  const htmlPath = join(tmpDir, `capture-${captureId}-${Date.now()}.html`);
  const pdfPath = join(tmpDir, `capture-${captureId}-${Date.now()}.pdf`);

  let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;

  try {
    await Bun.write(htmlPath, htmlBytes);

    browser = await chromium.launch({
      headless: true,
      executablePath: findChromiumExecutable(browsersPath),
    });

    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(captureTimeoutMs);
    await page.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (requestUrl.startsWith('file://') || requestUrl.startsWith('data:')) {
        await route.continue();
      } else {
        await route.abort('blockedbyclient');
      }
    });

    // Load from file:// — all assets must already be inline.
    await page.goto(`file://${htmlPath}`, { waitUntil: 'load' });

    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: false,
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
    });

    const pdfBytes = new Uint8Array(await Bun.file(pdfPath).arrayBuffer());
    const filename = slugify(meta.title ?? `capture-${captureId}`) + '.pdf';

    return { pdf: pdfBytes, filename };
  } finally {
    if (browser) await browser.close().catch(() => {});
    // Delete temp files — no PDF retained
    for (const p of [htmlPath, pdfPath]) {
      if (existsSync(p)) unlinkSync(p);
    }
  }
}
