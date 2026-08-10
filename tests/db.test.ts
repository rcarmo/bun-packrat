/**
 * bun-packrat — database unit tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture, getCaptureById, listCaptures, searchCaptures, updateLatestCapture } from '../src/db/index.js';
import type { Database } from 'bun:sqlite';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('schema migrations', () => {
  test('applies migration 001 without error', () => {
    const row = db
      .query<{ version: number }, []>('SELECT version FROM schema_migrations')
      .get();
    expect(row?.version).toBe(1);
  });

  test('creates all required tables', () => {
    const tables = db
      .query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `)
      .all()
      .map((r) => r.name);

    expect(tables).toContain('captures');
    expect(tables).toContain('urls');
    expect(tables).toContain('capture_aliases');
    expect(tables).toContain('metadata');
    expect(tables).toContain('tags');
    expect(tables).toContain('capture_tags');
    expect(tables).toContain('jobs');
    expect(tables).toContain('attempts');
    expect(tables).toContain('archivebox_imports');
    expect(tables).toContain('schema_migrations');
  });

  test('creates captures_fts virtual table', () => {
    const fts = db
      .query<{ name: string }, []>(`
        SELECT name FROM sqlite_master WHERE type='table' AND name='captures_fts'
      `)
      .get();
    expect(fts?.name).toBe('captures_fts');
  });

  test('is idempotent — running twice does not error', () => {
    expect(() => runMigrations(db)).not.toThrow();
  });
});

describe('getOrCreateUrl', () => {
  test('creates a new URL row', () => {
    const row = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    expect(row.id).toBeGreaterThan(0);
    expect(row.normalised).toBe('https://example.com/');
    expect(row.domain).toBe('example.com');
  });

  test('returns existing row on second call', () => {
    const a = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const b = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    expect(a.id).toBe(b.id);
  });

  test('strips www from domain', () => {
    const row = getOrCreateUrl(db, 'https://www.example.com/', 'https://www.example.com/');
    expect(row.domain).toBe('example.com');
  });
});

describe('insertCapture', () => {
  test('inserts a capture and returns an id', () => {
    const url = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const id = insertCapture(db, {
      url_id: url.id,
      source_url: 'https://example.com/',
      final_url: 'https://example.com/',
      html: null,
      compression: 'none',
      content_hash: null,
      html_size: null,
      title: 'Example',
      author: null,
      site_name: null,
      published_at: null,
      excerpt: null,
      lang: null,
      extracted_text: null,
      mode: 'article',
      status: 'pending',
      capture_tool: 'test/0',
      warnings: null,
    });
    expect(id).toBeGreaterThan(0);
  });

  test('retrieves the inserted capture', () => {
    const url = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const id = insertCapture(db, {
      url_id: url.id,
      source_url: 'https://example.com/',
      final_url: 'https://example.com/',
      html: Buffer.from('<html></html>', 'utf-8'),
      compression: 'none',
      content_hash: 'abc123',
      html_size: 13,
      title: 'Test Page',
      author: 'Test Author',
      site_name: 'Test Site',
      published_at: null,
      excerpt: 'A test excerpt',
      lang: 'en',
      extracted_text: 'full text here',
      mode: 'article',
      status: 'succeeded',
      capture_tool: 'test/0',
      warnings: null,
    });

    const c = getCaptureById(db, id);
    expect(c).not.toBeNull();
    expect(c!.title).toBe('Test Page');
    expect(c!.status).toBe('succeeded');
    expect(c!.mode).toBe('article');
  });
});

describe('FTS search', () => {
  test('indexes a capture and finds it by title', () => {
    const url = getOrCreateUrl(db, 'https://news.example.com/article', 'https://news.example.com/article');
    insertCapture(db, {
      url_id: url.id,
      source_url: 'https://news.example.com/article',
      final_url: 'https://news.example.com/article',
      html: null,
      compression: 'none',
      content_hash: null,
      html_size: null,
      title: 'Quantum computing breakthrough',
      author: 'Jane Doe',
      site_name: 'Example News',
      published_at: null,
      excerpt: null,
      lang: 'en',
      extracted_text: 'Scientists announce a major leap in quantum computing research.',
      mode: 'article',
      status: 'succeeded',
      capture_tool: 'test/0',
      warnings: null,
    });

    const results = searchCaptures(db, 'quantum computing', { limit: 10 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBe('Quantum computing breakthrough');
  });

  test('returns empty results for unmatched query', () => {
    const results = searchCaptures(db, 'xyzzy_does_not_exist_42', { limit: 10 });
    expect(results.length).toBe(0);
  });
});

describe('listCaptures', () => {
  test('returns only succeeded captures', () => {
    const url = getOrCreateUrl(db, 'https://a.example.com/', 'https://a.example.com/');
    insertCapture(db, { url_id: url.id, source_url: 'https://a.example.com/', final_url: 'https://a.example.com/', html: null, compression: 'none', content_hash: null, html_size: null, title: 'A', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null });
    insertCapture(db, { url_id: url.id, source_url: 'https://a.example.com/', final_url: 'https://a.example.com/', html: null, compression: 'none', content_hash: null, html_size: null, title: 'B', author: null, site_name: null, published_at: null, excerpt: null, lang: null, extracted_text: null, mode: 'article', status: 'failed', capture_tool: 'test/0', warnings: null });

    const rows = listCaptures(db, { status: 'succeeded' });
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
  });
});
