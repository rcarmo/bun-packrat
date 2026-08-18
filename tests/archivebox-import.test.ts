import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, runMigrations } from '../src/db/index.js';
import { importArchiveBox } from '../src/import/archivebox.js';
import { renderStoredCaptureHtml } from '../src/capture/canonical.js';

let root: string;
let target: Database;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'packrat-archivebox-'));
  target = openDatabase(join(root, 'packrat.sqlite'));
  runMigrations(target);
});
afterEach(() => { target.close(); rmSync(root, { recursive: true, force: true }); });

function sourceFixture(): string {
  const data = join(root, 'source');
  mkdirSync(join(data, 'archive', '1700000000.1'), { recursive: true });
  mkdirSync(join(data, 'archive', '1700000001.1'), { recursive: true });
  const source = new Database(join(data, 'index.sqlite3'), { create: true });
  source.exec(`
    CREATE TABLE core_snapshot(id TEXT PRIMARY KEY,url TEXT NOT NULL,timestamp TEXT NOT NULL,title TEXT,bookmarked_at TEXT NOT NULL,downloaded_at TEXT);
    CREATE TABLE core_archiveresult(id TEXT PRIMARY KEY,snapshot_id TEXT NOT NULL,extractor TEXT NOT NULL,status TEXT NOT NULL,output TEXT NOT NULL);
    CREATE TABLE core_tag(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE core_snapshot_tags(id INTEGER PRIMARY KEY,snapshot_id TEXT NOT NULL,tag_id TEXT NOT NULL);
    INSERT INTO core_snapshot VALUES
      ('one','https://example.com/article?utm_source=old','1700000000.1','Source title','2023-11-14 22:13:20','2023-11-14 22:13:21'),
      ('two','https://example.com/metadata','1700000001.1','Metadata title','2023-11-14 22:13:21',NULL),
      ('three','https://example.com/missing','1700000002.1','Missing directory','2023-11-14 22:13:22',NULL);
    INSERT INTO core_archiveresult VALUES ('r1','one','singlefile','succeeded','singlefile.html');
    INSERT INTO core_tag VALUES ('tag1','research');
    INSERT INTO core_snapshot_tags(snapshot_id,tag_id) VALUES ('one','tag1');
  `);
  source.close();
  writeFileSync(join(data, 'archive', '1700000000.1', 'singlefile.html'), `<!doctype html><html><head><title>Imported title</title><style>body{color:#123;background:url(https://tracker.invalid/x)}</style><script>alert(1)</script></head><body onload="evil()"><main><h1>Imported title</h1><p>${'Useful offline body '.repeat(30)}</p><img src="data:image/png;base64,AA=="><img src="https://remote.invalid/x.png"></main></body></html>`);
  return data;
}

describe('ArchiveBox importer', () => {
  test('inventories the source without writing target rows', async () => {
    const data = sourceFixture();
    const report = await importArchiveBox(target, { dataRoot: data, dryRun: true });
    expect(report.ok).toBe(true);
    expect(report.source.snapshots).toBe(3);
    expect(report.source.snapshotDirectories).toBe(2);
    expect(report.source.snapshotsWithoutDirectory).toBe(1);
    expect(report.source.candidateFiles['singlefile.html'].count).toBe(1);
    expect(target.query<{ n:number },[]>('SELECT count(*) n FROM captures').get()?.n).toBe(0);
    expect(target.query<{ n:number },[]>('SELECT count(*) n FROM archivebox_imports').get()?.n).toBe(0);
  });

  test('imports offline SingleFile, preserves metadata rows and resumes terminal outcomes', async () => {
    const data = sourceFixture();
    const first = await importArchiveBox(target, { dataRoot: data, compression: 'gzip' });
    expect(first.ok).toBe(true);
    expect(first.reconciliation).toEqual({ terminal: 3, pending: 0, total: 3 });
    expect(first.outcomes.imported).toBe(3);
    const rows = target.query<any, []>('SELECT * FROM captures ORDER BY id').all();
    expect(rows).toHaveLength(3);
    expect(rows[0].mode).toBe('imported_singlefile');
    expect(rows[0].compression).toBe('gzip');
    expect(rows[1].mode).toBe('metadata_only');
    expect(rows[2].mode).toBe('metadata_only');
    expect(rows[0].captured_at).toBe('2023-11-14T22:13:21Z');
    expect(target.query<{ normalised:string },[]>('SELECT normalised FROM urls ORDER BY id LIMIT 1').get()?.normalised).toBe('https://example.com/article');
    expect(target.query<{ name:string },[]>('SELECT name FROM tags').get()?.name).toBe('research');
    const rendered = renderStoredCaptureHtml(rows[0]);
    expect(rendered).toContain('Imported title');
    expect(rendered).toContain('Content-Security-Policy');
    expect(rendered).not.toContain('<script');
    expect(rendered).not.toContain('onload=');
    expect(rendered).not.toContain('remote.invalid');
    expect(rendered).not.toContain('tracker.invalid');

    const second = await importArchiveBox(target, { dataRoot: data, compression: 'gzip' });
    expect(second.processed).toBe(0);
    expect(second.resumed).toBe(3);
    expect(target.query<{ n:number },[]>('SELECT count(*) n FROM captures').get()?.n).toBe(3);
    const verified = await importArchiveBox(target, { dataRoot: data, verifyOnly: true });
    expect(verified.ok).toBe(true);
    const emptyTarget = openDatabase(join(root, 'empty.sqlite'));
    runMigrations(emptyTarget);
    const emptyVerification = await importArchiveBox(emptyTarget, { dataRoot: data, verifyOnly: true });
    expect(emptyVerification.ok).toBe(false);
    expect(emptyVerification.reconciliation).toEqual({ terminal: 0, pending: 3, total: 3 });
    expect(emptyVerification.failures).toHaveLength(3);
    emptyTarget.close();
  });

  test('falls back from an oversized SingleFile candidate to bounded rendered HTML', async () => {
    const data = sourceFixture();
    writeFileSync(join(data, 'archive', '1700000000.1', 'singlefile.html'), `<!doctype html><html><body><p>${'Oversized '.repeat(300)}</p></body></html>`);
    writeFileSync(join(data, 'archive', '1700000000.1', 'output.html'), `<!doctype html><html><head><title>Rendered fallback</title></head><body><p>${'Fallback body '.repeat(30)}</p></body></html>`);
    const report = await importArchiveBox(target, { dataRoot: data, maxCandidateBytes: 1000 });
    expect(report.ok).toBe(true);
    const capture = target.query<any, []>("SELECT * FROM captures WHERE source_url LIKE 'https://example.com/article%'").get();
    expect(capture.mode).toBe('full_page');
    expect(renderStoredCaptureHtml(capture)).toContain('Rendered fallback');
    expect(capture.warnings).toContain('singlefile.html exceeds');
  });

  test('falls back to metadata-only when every HTML candidate is malformed', async () => {
    const data = sourceFixture();
    writeFileSync(join(data, 'archive', '1700000000.1', 'singlefile.html'), 'not html');
    writeFileSync(join(data, 'archive', '1700000000.1', 'output.html'), '<!doctype html><html><body></body></html>');
    const report = await importArchiveBox(target, { dataRoot: data });
    expect(report.ok).toBe(true);
    expect(report.outcomes.failed ?? 0).toBe(0);
    const capture = target.query<any, []>("SELECT * FROM captures WHERE source_url LIKE 'https://example.com/article%'").get();
    expect(capture.mode).toBe('metadata_only');
    expect(capture.html).toBeNull();
    expect(capture.warnings).toContain('singlefile.html rejected');
    expect(capture.warnings).toContain('output.html rejected');
  });

  test('records exact canonical duplicates without storing another capture body', async () => {
    const data = sourceFixture();
    const singlefile = Bun.file(join(data, 'archive', '1700000000.1', 'singlefile.html'));
    mkdirSync(join(data, 'archive', '1700000003.1'), { recursive: true });
    await Bun.write(join(data, 'archive', '1700000003.1', 'singlefile.html'), await singlefile.arrayBuffer());
    const source = new Database(join(data, 'index.sqlite3'));
    source.exec("INSERT INTO core_snapshot VALUES ('four','https://example.net/copy','1700000003.1','Copy','2023-11-14 22:13:23','2023-11-14 22:13:24')");
    source.close();
    const report = await importArchiveBox(target, { dataRoot: data });
    expect(report.outcomes.duplicate).toBe(1);
    expect(target.query<{ n:number },[]>('SELECT count(*) n FROM captures').get()?.n).toBe(3);
    expect(target.query<{ outcome:string; capture_id:number },[string]>('SELECT outcome,capture_id FROM archivebox_imports WHERE ab_id=?').get('four')?.outcome).toBe('duplicate');
    const duplicate = target.query<{ capture_id:number },[string]>('SELECT capture_id FROM archivebox_imports WHERE ab_id=?').get('four')!;
    expect(target.query<{ n:number },[number,string]>('SELECT count(*) n FROM capture_aliases WHERE capture_id=? AND url=?').get(duplicate.capture_id, 'https://example.net/copy')?.n).toBe(1);
  });

  test('rejects an unknown ArchiveBox schema before writing discovery rows', async () => {
    const data = join(root, 'unsupported');
    mkdirSync(join(data, 'archive'), { recursive: true });
    const source = new Database(join(data, 'index.sqlite3'), { create: true });
    source.exec('CREATE TABLE core_snapshot(id TEXT,url TEXT)');
    source.close();
    await expect(importArchiveBox(target, { dataRoot: data })).rejects.toThrow('Unsupported ArchiveBox schema');
    expect(target.query<{ n:number },[]>('SELECT count(*) n FROM archivebox_imports').get()?.n).toBe(0);
  });
});
