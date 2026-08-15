import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { openDatabase, runMigrations, getOrCreateUrl, insertCapture, updateLatestCapture, createJob, getCaptureById, getCaptureDeleteImpact, deleteCapture, setCaptureImageSources, countCaptures, listCaptures } from '../src/db/index.js';
import { renderRemoteMarkdown } from '../src/export/markdown.js';
import { renderMarkdownHtml } from '../src/export/render-markdown.js';
import { resolveCaptureIndexPage } from '../src/index-page.js';
import { INDEX_CLIENT_SCRIPT } from '../src/index-client.js';

let db: Database;
beforeEach(() => { db = openDatabase(':memory:'); runMigrations(db); });
afterEach(() => db.close());

function add(urlString: string, title: string, capturedAt = '2026-01-01T00:00:00Z') {
  const url = getOrCreateUrl(db, urlString, urlString);
  const html = Buffer.from(`<html><body><div class="packrat-content"><h1>${title}</h1><p>Body text</p><img src="data:image/png;base64,AA==" alt="Diagram"></div></body></html>`);
  const id = insertCapture(db, { url_id:url.id, source_url:urlString, final_url:urlString, html, compression:'none', content_hash:'x', html_size:html.length, title, author:null, site_name:null, published_at:null, excerpt:null, lang:'en', extracted_text:`${title} Body text`, mode:'article', status:'succeeded', capture_tool:'test', warnings:null });
  db.exec('UPDATE captures SET captured_at=? WHERE id=?', [capturedAt, id]);
  updateLatestCapture(db, url.id, id);
  return { id, url };
}

describe('index client', () => {
  test('inline client script is valid JavaScript', () => {
    expect(() => new Function(INDEX_CLIENT_SCRIPT)).not.toThrow();
  });

  test('keeps secondary list actions behind one disclosure', () => {
    expect(INDEX_CLIENT_SCRIPT).toContain("document.querySelectorAll('.item-more')");
    expect(INDEX_CLIENT_SCRIPT).toContain("event.key === 'Escape'");
  });
});

describe('capture deletion', () => {
  test('removes dependent rows, preserves job history and selects replacement latest capture', () => {
    const first = add('https://example.com/a', 'First', '2026-01-01T00:00:00Z');
    const second = add('https://example.com/a', 'Second', '2026-01-02T00:00:00Z');
    db.exec("INSERT INTO capture_aliases(capture_id,url) VALUES (?, 'https://example.com/old')", [second.id]);
    db.exec("INSERT INTO metadata(capture_id,key,value) VALUES (?, 'x', 'y')", [second.id]);
    const job = createJob(db, 'capture', { url: second.url.original });
    db.exec("UPDATE jobs SET capture_id=?, status='succeeded', result='{}' WHERE id=?", [second.id, job]);
    expect(getCaptureDeleteImpact(db, second.id)?.jobs).toBe(1);
    const result = deleteCapture(db, second.id)!;
    expect(result.newLatestCapture).toBe(first.id);
    expect(getCaptureById(db, second.id)).toBeNull();
    expect(db.query<{ capture_id:number|null; result:string },[number]>('SELECT capture_id,result FROM jobs WHERE id=?').get(job)?.capture_id).toBeNull();
    expect(db.query<{ latest_capture:number },[number]>('SELECT latest_capture FROM urls WHERE id=?').get(first.url.id)?.latest_capture).toBe(first.id);
  });

  test('retains URL identity while a job references an equivalent normalised URL', () => {
    const capture = add('https://example.com/article', 'Only capture');
    createJob(db, 'capture', { url: 'https://EXAMPLE.com/article?utm_source=queue' });
    const result = deleteCapture(db, capture.id)!;
    expect(result.orphanUrlRemoved).toBe(false);
    expect(db.query<{ id:number },[number]>('SELECT id FROM urls WHERE id=?').get(capture.url.id)?.id).toBe(capture.url.id);
  });

  test('ignores malformed unrelated legacy job payloads during deletion', () => {
    const capture = add('https://example.com/delete', 'Delete me');
    db.exec("INSERT INTO jobs(kind,status,payload) VALUES ('legacy','failed','{broken')");
    expect(deleteCapture(db, capture.id)?.orphanUrlRemoved).toBe(true);
  });
});

describe('sorting and paging primitives', () => {
  test('uses deterministic id tie-breaking and matching counts', () => {
    const a = add('https://example.com/1', 'Same time');
    const b = add('https://example.com/2', 'Same time');
    expect(listCaptures(db, { sort:'newest' }).map((c) => c.id)).toEqual([b.id, a.id]);
    expect(listCaptures(db, { sort:'oldest' }).map((c) => c.id)).toEqual([a.id, b.id]);
    expect(countCaptures(db, 'Same', {})).toBe(2);
  });

  test('includes the whole dateTo day for ISO timestamps', () => {
    add('https://example.com/morning', 'Morning', '2026-01-02T00:00:00Z');
    add('https://example.com/evening', 'Evening', '2026-01-02T23:59:59Z');
    add('https://example.com/tomorrow', 'Tomorrow', '2026-01-03T00:00:00Z');
    expect(listCaptures(db, { dateTo:'2026-01-02' }).map((capture) => capture.title)).toEqual(['Evening', 'Morning']);
    expect(countCaptures(db, null, { dateTo:'2026-01-02' })).toBe(2);
  });

  test('clamps an empty requested page to the nearest preceding page', () => {
    for (let i = 0; i < 6; i++) add(`https://example.com/${i}`, `Capture ${i}`);
    const page = resolveCaptureIndexPage(db, '', { limit:5, offset:10 });
    expect(page.effectiveOffset).toBe(5);
    expect(page.rows).toHaveLength(1);
  });

  test('returns a user-facing error for malformed FTS syntax', () => {
    add('https://example.com/search', 'Searchable');
    const page = resolveCaptureIndexPage(db, '"unterminated', { limit:5, offset:0 });
    expect(page.rows).toEqual([]);
    expect(page.error).toContain('Invalid search query');
  });
});

describe('Markdown reading mode', () => {
  test('uses original image URLs and safely gates rendered remote images', async () => {
    const capture = add('https://example.com/a', 'Markdown');
    setCaptureImageSources(db, capture.id, [{ order:0, originalUrl:'https://images.example.com/diagram.png', alt:'Diagram', title:'Architecture', width:null, height:null }]);
    db.exec("UPDATE captures SET html=? WHERE id=?", [Buffer.from('<html><body><header class=\"packrat-header\">Archive metadata must not leak</header><div class=\"packrat-content\"><h1>Markdown</h1><p>Body text</p><img src=\"data:image/png;base64,AA==\" alt=\"Diagram\"></div></body></html>'), capture.id]);
    const result = await renderRemoteMarkdown(db, capture.id);
    expect(result?.markdown).toContain('![Diagram](https://images.example.com/diagram.png "Architecture")');
    expect(result?.markdown).not.toContain('Archive metadata must not leak');
    expect(result?.markdown).not.toContain('data:image');
    expect(renderMarkdownHtml(result!.markdown, false)).toContain('<span class="image-placeholder"');
    expect(renderMarkdownHtml(result!.markdown, false)).toContain('>Diagram</span>');
    expect(renderMarkdownHtml(result!.markdown, false)).not.toContain('[Image:');
    expect(renderMarkdownHtml(result!.markdown, false)).not.toContain('<img');
    expect(renderMarkdownHtml(result!.markdown, true)).toContain('<img src="https://images.example.com/diagram.png"');
  });

  test('keeps ordinary raw Markdown links readable', async () => {
    const capture = add('https://example.com/link', 'Links');
    db.exec('UPDATE captures SET html=? WHERE id=?', [Buffer.from('<html><body><div class="packrat-content"><p>Hello, <a href="https://lighthousenewsletter.com/about">Rafael</a> here.</p></div></body></html>'), capture.id]);
    const result = await renderRemoteMarkdown(db, capture.id);
    expect(result?.markdown).toContain('[Rafael](https://lighthousenewsletter.com/about)');
    expect(result?.markdown).not.toContain('[Rafael](<');
    expect(renderMarkdownHtml(result!.markdown, false)).toContain('<a href="https://lighthousenewsletter.com/about"');
  });

  test('renders generated pipe tables as responsive semantic HTML', () => {
    const markdown = '| Model | Average | Notes |\n| --- | ---: | --- |\n| Alpha | 42 | A \\| B |\n| Beta | 7 | Safe |';
    const rendered = renderMarkdownHtml(markdown, false);
    expect(rendered).toContain('<div class="table-scroll"><table>');
    expect(rendered).toContain('<th>Model</th>');
    expect(rendered).toContain('<td>A | B</td>');
    expect(rendered.match(/<tr>/g)).toHaveLength(3);
    expect(rendered).not.toContain('<p>|');
  });

  test('does not treat ordinary pipe-prefixed text as a table', () => {
    expect(renderMarkdownHtml('| not a table |', false)).toContain('<p>| not a table |</p>');
  });

  test('renders angle-bracketed links and images whose URLs contain parentheses', () => {
    const image = 'https://images.example.com/diagram_(final).png';
    const page = 'https://example.com/read_(this)';
    const markdown = `![Diagram](<${image}>)\n[Read](<${page}>)`;
    const rendered = renderMarkdownHtml(markdown, true);
    expect(rendered).toContain(`src="${image}"`);
    expect(rendered).toContain(`href="${page}"`);
  });
});
