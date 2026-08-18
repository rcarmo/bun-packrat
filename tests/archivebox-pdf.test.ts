import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyArchiveBoxOriginalPdf, enrichArchiveBoxPdfs } from '../src/import/archivebox-pdf.js';
import { getOrCreateUrl, getSourcePdfBytes, insertCapture, openDatabase, runMigrations } from '../src/db/index.js';

let root: string;
let target: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'packrat-ab-pdf-'));
  target = openDatabase(join(root, 'target.sqlite'));
  runMigrations(target);
});
afterEach(() => { target.close(); rmSync(root, { recursive: true, force: true }); });

function sourceFixture(): { data: string; pdf: Buffer; captureIds: number[] } {
  const data = join(root, 'source');
  const archive = join(data, 'archive');
  for (const timestamp of ['1700000000.1', '1700000001.1', '1700000002.1']) mkdirSync(join(archive, timestamp, 'example.com'), { recursive: true });
  const source = new Database(join(data, 'index.sqlite3'), { create: true });
  source.exec(`
    CREATE TABLE core_snapshot(id TEXT PRIMARY KEY,url TEXT,timestamp TEXT,title TEXT,bookmarked_at TEXT,downloaded_at TEXT);
    CREATE TABLE core_archiveresult(id TEXT PRIMARY KEY,snapshot_id TEXT,extractor TEXT,status TEXT,output TEXT);
    INSERT INTO core_snapshot VALUES
      ('original','https://example.com/report.pdf','1700000000.1','Original','2023-01-01',NULL),
      ('generated','https://example.com/article','1700000001.1','Generated','2023-01-01',NULL),
      ('ambiguous','https://example.com/ambiguous.pdf','1700000002.1','Ambiguous','2023-01-01',NULL);
    INSERT INTO core_archiveresult VALUES
      ('h1','original','headers','succeeded','headers.json'),('w1','original','wget','succeeded','example.com/report.pdf'),
      ('p2','generated','pdf','succeeded','output.pdf'),('h2','generated','headers','succeeded','headers.json'),('w2','generated','wget','succeeded','example.com/article.html'),
      ('h3','ambiguous','headers','succeeded','headers.json'),('w3','ambiguous','wget','succeeded','example.com/ambiguous.pdf');
  `);
  source.close();
  const pdf = Buffer.from('%PDF-1.4\nverified original\n%%EOF\n');
  writeFileSync(join(archive, '1700000000.1', 'example.com', 'report.pdf'), pdf);
  writeFileSync(join(archive, '1700000000.1', 'headers.json'), JSON.stringify({ 'Content-Type':'application/pdf', 'Content-Length':String(pdf.byteLength) }));
  writeFileSync(join(archive, '1700000001.1', 'output.pdf'), pdf);
  writeFileSync(join(archive, '1700000001.1', 'example.com', 'article.html'), '<html>article</html>');
  writeFileSync(join(archive, '1700000001.1', 'headers.json'), JSON.stringify({ 'Content-Type':'text/html' }));
  writeFileSync(join(archive, '1700000002.1', 'example.com', 'ambiguous.pdf'), pdf);
  writeFileSync(join(archive, '1700000002.1', 'headers.json'), JSON.stringify({ 'Content-Type':'text/html' }));

  const captureIds: number[] = [];
  for (const [index, id] of ['original','generated','ambiguous'].entries()) {
    const urlValue = `https://example.com/${id}`;
    const url = getOrCreateUrl(target, urlValue, urlValue);
    const captureId = insertCapture(target, { url_id:url.id,source_url:urlValue,final_url:urlValue,html:null,compression:'none',content_hash:null,html_size:null,title:id,author:null,site_name:null,published_at:null,excerpt:null,lang:null,extracted_text:id,mode:'metadata_only',status:'succeeded',capture_tool:'test',warnings:null });
    captureIds.push(captureId);
    target.query(`INSERT INTO archivebox_imports(ab_id,ab_url,ab_timestamp,capture_id,outcome) VALUES (?,?,?,?, 'imported')`)
      .run(id, urlValue, `170000000${index}.${index + 1}`, captureId);
  }
  return { data, pdf, captureIds };
}

describe('ArchiveBox original PDF classifier', () => {
  test('accepts only a successful wget response with PDF headers and signature', () => {
    const { data, pdf } = sourceFixture();
    const result = classifyArchiveBoxOriginalPdf(join(data, 'archive'), '1700000000.1', [
      { extractor:'headers',status:'succeeded',output:'headers.json' },
      { extractor:'wget',status:'succeeded',output:'example.com/report.pdf' },
      { extractor:'pdf',status:'succeeded',output:'output.pdf' },
    ], 1024);
    expect(result.candidate?.byteSize).toBe(pdf.byteLength);
    expect(result.candidate?.relativePath).toBe('archive/1700000000.1/example.com/report.pdf');
  });

  test('rejects generated and MIME-ambiguous PDFs', () => {
    const { data } = sourceFixture();
    const generated = classifyArchiveBoxOriginalPdf(join(data, 'archive'), '1700000001.1', [
      { extractor:'pdf',status:'succeeded',output:'output.pdf' },
      { extractor:'headers',status:'succeeded',output:'headers.json' },
      { extractor:'wget',status:'succeeded',output:'example.com/article.html' },
    ], 1024);
    expect(generated.candidate).toBeNull();
    expect(generated.detail).toContain('MIME');
    const ambiguous = classifyArchiveBoxOriginalPdf(join(data, 'archive'), '1700000002.1', [
      { extractor:'headers',status:'succeeded',output:'headers.json' },
      { extractor:'wget',status:'succeeded',output:'example.com/ambiguous.pdf' },
    ], 1024);
    expect(ambiguous.candidate).toBeNull();
  });
});

describe('ArchiveBox PDF enrichment', () => {
  test('checkpoints every provenance row, enriches verified originals, resumes, and verifies bytes', async () => {
    const { data, pdf, captureIds } = sourceFixture();
    const options = { dataRoot:data,maxPdfBytes:1024,extractionTimeoutMs:10_000,maxPages:1000,maxTextBytes:1024 };
    const first = await enrichArchiveBoxPdfs(target, options);
    expect(first.ok).toBe(true);
    expect(first.processed).toBe(3);
    expect(first.statuses).toEqual({ enriched:1, not_original_pdf:2 });
    expect(Buffer.from(getSourcePdfBytes(target, captureIds[0])!).equals(pdf)).toBe(true);
    expect(target.query<{ mode:string },[number]>('SELECT mode FROM captures WHERE id=?').get(captureIds[0])?.mode).toBe('pdf');
    expect(getSourcePdfBytes(target, captureIds[1])).toBeNull();
    const second = await enrichArchiveBoxPdfs(target, options);
    expect(second.processed).toBe(0);
    expect(second.resumed).toBe(3);
    const verified = await enrichArchiveBoxPdfs(target, { ...options, verifyOnly:true });
    expect(verified.ok).toBe(true);
    expect(verified.failures).toEqual([]);
  });

  test('leaves a bounded pending suffix and safely resumes after interruption', async () => {
    const { data } = sourceFixture();
    const options = { dataRoot:data,maxPdfBytes:1024,extractionTimeoutMs:10_000,maxPages:1000,maxTextBytes:1024 };
    const partial = await enrichArchiveBoxPdfs(target, { ...options, limit:1 });
    expect(partial.processed).toBe(1);
    expect(partial.statuses.pending).toBe(2);
    const resumed = await enrichArchiveBoxPdfs(target, options);
    expect(resumed.processed).toBe(2);
    expect(resumed.statuses.pending ?? 0).toBe(0);
  });
});
