import { describe, expect, test } from 'bun:test';
import { deriveStoredArticleHtml, detectStoredCaptureFormat, renderMhtmlToHtml, renderStoredCaptureHtml } from '../src/capture/canonical.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const BOUNDARY = '----PackratFixtureBoundary';
const ARTICLE = '<h1>Canonical full page</h1>' + '<p>Detailed archival article text with deterministic content for extraction.</p>'.repeat(8);

function qp(value: string): string {
  return value.replace(/=/g, '=3D');
}

function fixture(lineEnding = '\r\n'): string {
  const lines = [
    'From: <Saved by Blink>',
    'Snapshot-Content-Location: https://example.com/article',
    'Subject: Canonical fixture',
    'MIME-Version: 1.0',
    'Content-Type: multipart/related;',
    `\ttype="text/html"; boundary="${BOUNDARY}"`,
    '',
    '',
    `--${BOUNDARY}`,
    'Content-Type: text/html',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://example.com/article',
    '',
    qp(`<!doctype html><html><head><title>Fixture</title><link rel="stylesheet" href="https://example.com/site.css"><script>alert(1)</script></head><body onload="evil()"><nav>Full page navigation</nav><main><article>${ARTICLE}<img src="https://example.com/pixel.png" srcset="https://remote.invalid/two.png 2x"><img data-attrs='{"src":"https://origin.example/lazy.png"}' alt="Lazy captured"><form action="https://remote.invalid/post"><button>Send</button><p>Kept form text</p></form></article></main></body></html>`),
    `--${BOUNDARY}`,
    'Content-Type: text/css',
    'Content-Transfer-Encoding: quoted-printable',
    'Content-Location: https://example.com/site.css',
    '',
    qp('body { color: rgb(1, 2, 3); background-image: url("pixel.png"); } @import "https://remote.invalid/x.css";'),
    `--${BOUNDARY}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://example.com/pixel.png',
    '',
    PNG.toString('base64'),
    `--${BOUNDARY}`,
    'Content-Type: image/png',
    'Content-Transfer-Encoding: base64',
    'Content-Location: https://cdn.example/image/fetch/https%3A%2F%2Forigin.example%2Flazy.png',
    '',
    PNG.toString('base64'),
    `--${BOUNDARY}--`,
    '',
  ];
  return lines.join(lineEnding);
}

describe('canonical capture formats', () => {
  test('detects legacy HTML and Chromium MHTML', () => {
    expect(detectStoredCaptureFormat(Buffer.from('  <!doctype html><html></html>'))).toBe('html');
    expect(detectStoredCaptureFormat(Buffer.from(fixture()))).toBe('mhtml');
  });

  test('renders MHTML as safe self-contained full-page HTML', () => {
    const html = renderMhtmlToHtml(fixture());
    expect(html).toContain('Full page navigation');
    expect(html).toContain('Canonical full page');
    expect(html).toContain('color: rgb(1, 2, 3)');
    expect(html).toContain(':not(pre)>code{overflow-wrap:anywhere');
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html.match(/data:image\/png;base64,/g)).toHaveLength(3);
    expect(html).toContain('alt="Lazy captured"');
    expect(html).toContain('Kept form text');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('onload=');
    expect(html).not.toContain('srcset=');
    expect(html).not.toContain('remote.invalid');
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i);
    expect(html).not.toMatch(/url\(["']?https?:/i);
  });

  test('preserves raw binary image bytes while rendering stored MHTML', () => {
    const marker = Buffer.from([0x00, 0x80, 0x81, 0xfe, 0xff]);
    const raw = Buffer.from([
      'From: <Saved by Blink>',
      'Snapshot-Content-Location: https://example.com/raw',
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="raw-boundary"',
      '',
      '--raw-boundary',
      'Content-Type: text/html',
      'Content-Location: https://example.com/raw',
      '',
      '<html><body><img src="raw.png"></body></html>',
      '--raw-boundary',
      'Content-Type: image/png',
      'Content-Transfer-Encoding: binary',
      'Content-Location: https://example.com/raw.png',
      '',
      marker.toString('latin1'),
      '--raw-boundary--',
      '',
    ].join('\r\n'), 'latin1');
    const html = renderStoredCaptureHtml({ html: raw, compression: 'none' });
    const encoded = html.match(/data:image\/png;base64,([^"']+)/)?.[1];
    expect(encoded).toBeTruthy();
    expect(Buffer.from(encoded!, 'base64')).toEqual(marker);
  });

  test('supports LF-only MHTML and gzip storage', () => {
    const raw = Buffer.from(fixture('\n'));
    const compressed = Bun.gzipSync(raw);
    const html = renderStoredCaptureHtml({ html: compressed, compression: 'gzip' });
    expect(html).toContain('Canonical full page');
    expect(html).toContain('data:image/png;base64,');
  });

  test('passes ordinary legacy HTML through while removing blocking consent overlays at render time', () => {
    const legacy = '<!doctype html><html><body style="overflow:hidden"><article><h1>Legacy</h1><p>' + 'Readable article text. '.repeat(30) + '</p></article><div class="fc-consent-root">Consent wall</div><div id="cookie-law-info-bar" style="position:fixed;z-index:999">Cookies</div></body></html>';
    const rendered = renderStoredCaptureHtml({ html: Buffer.from(legacy), compression: 'none' });
    expect(rendered).toContain('<h1>Legacy</h1>');
    expect(rendered).not.toContain('fc-consent-root');
    expect(rendered).not.toContain('cookie-law-info-bar');
    expect(rendered).not.toContain('overflow:hidden');
    const article = deriveStoredArticleHtml({ html: Buffer.from(legacy), compression: 'none' }, 'https://example.com/article');
    expect(article).toContain('Readable article text');
    expect(article).not.toContain('Consent wall');
  });

  test('derives an article from MHTML without full-page navigation', () => {
    const article = deriveStoredArticleHtml({ html: Buffer.from(fixture()), compression: 'none' }, 'https://example.com/article');
    expect(article).toContain('Canonical full page');
    expect(article).toContain('Detailed archival article text');
    expect(article).toContain('data:image/png;base64,');
    expect(article).not.toContain('Full page navigation');
    expect(article.match(/<html\b/g)).toHaveLength(1);
    expect(article.match(/<head\b/g)).toHaveLength(1);
    expect(article.match(/<body\b/g)).toHaveLength(1);
    expect(article).not.toContain('<script');
  });
});
