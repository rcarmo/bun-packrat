/**
 * bun-packrat — HTML sanitiser unit tests
 */

import { describe, test, expect } from 'bun:test';
import { sanitizeHtml } from '../src/capture/sanitize.js';

describe('sanitizeHtml', () => {
  test('removes <script> tags and content', () => {
    const { html } = sanitizeHtml('<html><body><script>alert(1)</script><p>Hello</p></body></html>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('alert');
    expect(html).toContain('<p>Hello</p>');
  });

  test('removes inline event handlers', () => {
    const { html, warnings } = sanitizeHtml(
      '<html><body><div onclick="evil()" onmouseover="bad()">Text</div></body></html>',
    );
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('onmouseover');
    expect(html).toContain('Text');
    expect(warnings.some((w) => w.includes('onclick'))).toBe(true);
  });

  test('removes <iframe>', () => {
    const { html } = sanitizeHtml(
      '<html><body><iframe src="https://evil.example.com"></iframe><p>Safe</p></body></html>',
    );
    expect(html).not.toContain('<iframe');
    expect(html).toContain('<p>Safe</p>');
  });

  test('removes <form> and <input>', () => {
    const { html } = sanitizeHtml(
      '<html><body><form action="/submit"><input type="text"><button>Submit</button></form><p>Content</p></body></html>',
    );
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('<button');
    expect(html).toContain('<p>Content</p>');
  });

  test('preserves allowed elements: p, h1-h6, a, img, ul, li', () => {
    const input = `<html><body>
      <h1>Title</h1>
      <p>Paragraph with <strong>bold</strong> and <em>italic</em>.</p>
      <ul><li>Item 1</li><li>Item 2</li></ul>
      <a href="https://example.com">Link</a>
      <img src="data:image/png;base64,abc" alt="test">
    </body></html>`;
    const { html } = sanitizeHtml(input);
    expect(html).toContain('<h1>');
    expect(html).toContain('<p>');
    expect(html).toContain('<strong>');
    expect(html).toContain('<em>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>');
    expect(html).toContain('<a href');
    expect(html).toContain('<img');
  });

  test('removes javascript: href', () => {
    const { html, warnings } = sanitizeHtml(
      '<html><body><a href="javascript:evil()">Click</a></body></html>',
    );
    expect(html).not.toContain('javascript:');
    expect(html).toContain('href="#"');
    expect(warnings.some((w) => w.includes('href'))).toBe(true);
  });

  test('removes meta http-equiv refresh', () => {
    const { html, warnings } = sanitizeHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=https://evil.example.com"></head><body><p>Hello</p></body></html>',
    );
    expect(html).not.toContain('http-equiv');
    expect(warnings.some((w) => w.includes('refresh'))).toBe(true);
  });

  test('preserves code blocks', () => {
    const { html } = sanitizeHtml(
      '<html><body><pre><code>const x = 1;</code></pre></body></html>',
    );
    expect(html).toContain('<pre>');
    expect(html).toContain('<code>');
    expect(html).toContain('const x = 1;');
  });

  test('preserves table structure', () => {
    const { html } = sanitizeHtml(
      '<html><body><table><thead><tr><th>Col A</th></tr></thead><tbody><tr><td>Value</td></tr></tbody></table></body></html>',
    );
    expect(html).toContain('<table>');
    expect(html).toContain('<thead>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<th>');
    expect(html).toContain('<td>');
  });

  test('removes unrecognised elements but keeps their text', () => {
    const { html } = sanitizeHtml(
      '<html><body><custom-element>Keep this text</custom-element></body></html>',
    );
    expect(html).toContain('Keep this text');
    expect(html).not.toContain('<custom-element>');
  });

  test('removes HTML comments', () => {
    const { html } = sanitizeHtml(
      '<html><body><!-- This is a comment --><p>Visible</p></body></html>',
    );
    expect(html).not.toContain('<!--');
    expect(html).toContain('<p>Visible</p>');
  });
});
