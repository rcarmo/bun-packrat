/**
 * bun-packrat — URL normalisation unit tests
 */

import { describe, test, expect } from 'bun:test';
import { normaliseUrl, guardSsrf, guardSsrfResolved, isBlockedAddress, UrlValidationError } from '../src/capture/url.js';

describe('normaliseUrl', () => {
  test('returns the URL unchanged when clean', () => {
    expect(normaliseUrl('https://example.com/article')).toBe('https://example.com/article');
  });

  test('strips fragment', () => {
    expect(normaliseUrl('https://example.com/page#section')).toBe('https://example.com/page');
  });

  test('strips UTM tracking params', () => {
    const url = 'https://example.com/?utm_source=twitter&utm_medium=social&text=hello';
    const result = normaliseUrl(url);
    expect(result).not.toContain('utm_source');
    expect(result).not.toContain('utm_medium');
    expect(result).toContain('text=hello');
  });

  test('strips fbclid and gclid', () => {
    const url = 'https://example.com/?fbclid=abc123&gclid=xyz&p=1';
    const result = normaliseUrl(url);
    expect(result).not.toContain('fbclid');
    expect(result).not.toContain('gclid');
    expect(result).toContain('p=1');
  });

  test('lowercases hostname', () => {
    expect(normaliseUrl('https://EXAMPLE.COM/page')).toContain('example.com');
  });

  test('sorts query parameters for stability', () => {
    const a = normaliseUrl('https://example.com/?z=1&a=2');
    const b = normaliseUrl('https://example.com/?a=2&z=1');
    expect(a).toBe(b);
  });

  test('throws UrlValidationError for invalid URL', () => {
    expect(() => normaliseUrl('not a url')).toThrow(UrlValidationError);
  });

  test('throws for non-http schemes', () => {
    expect(() => normaliseUrl('ftp://example.com/')).toThrow(UrlValidationError);
    expect(() => normaliseUrl('file:///etc/passwd')).toThrow(UrlValidationError);
    expect(() => normaliseUrl('javascript:alert(1)')).toThrow(UrlValidationError);
  });

  test('rejects URLs containing embedded credentials', () => {
    expect(() => normaliseUrl('https://user:secret@example.com/')).toThrow(UrlValidationError);
  });
});

describe('guardSsrf', () => {
  test('allows public URLs', () => {
    expect(() => guardSsrf('https://example.com/')).not.toThrow();
    expect(() => guardSsrf('https://1.1.1.1/')).not.toThrow();
  });

  test('blocks localhost', () => {
    expect(() => guardSsrf('http://localhost/')).toThrow(UrlValidationError);
    expect(() => guardSsrf('http://localhost:8080/')).toThrow(UrlValidationError);
  });

  test('blocks 127.x.x.x', () => {
    expect(() => guardSsrf('http://127.0.0.1/')).toThrow(UrlValidationError);
    expect(() => guardSsrf('http://127.1.2.3/')).toThrow(UrlValidationError);
  });

  test('blocks RFC1918 ranges', () => {
    expect(() => guardSsrf('http://10.0.0.1/')).toThrow(UrlValidationError);
    expect(() => guardSsrf('http://172.16.0.1/')).toThrow(UrlValidationError);
    expect(() => guardSsrf('http://192.168.1.1/')).toThrow(UrlValidationError);
  });

  test('blocks 169.254.x.x link-local', () => {
    expect(() => guardSsrf('http://169.254.169.254/')).toThrow(UrlValidationError);
  });

  test('allows an explicitly allow-listed private host', () => {
    expect(() => guardSsrf('http://192.168.1.100/', ['192.168.1.100'])).not.toThrow();
  });

  test('blocks additional reserved address ranges', () => {
    for (const address of ['0.1.2.3', '100.64.0.1', '192.0.0.1', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::', 'ff02::1']) {
      expect(isBlockedAddress(address)).toBe(true);
    }
  });

  test('allows public addresses elsewhere in 192.0.0.0/16', () => {
    expect(isBlockedAddress('192.0.66.239')).toBe(false);
    expect(() => guardSsrf('https://192.0.66.239/image.jpg')).not.toThrow();
  });

  test('resolved guard accepts a normal public hostname', async () => {
    await expect(guardSsrfResolved('https://example.com/')).resolves.toBeUndefined();
  });
});
