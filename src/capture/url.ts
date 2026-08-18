/**
 * bun-packrat — URL normalisation and SSRF guard
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** Tracking/noise query parameters to strip */
const STRIP_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_source_platform', 'utm_creative_format', 'utm_marketing_tactic',
  'fbclid', 'gclid', 'msclkid', 'twclid', 'li_fat_id', 'mc_eid',
  'mc_cid', 'ref', 'referrer', '_ga',
]);

/** Private/reserved address ranges for SSRF guard */
const BLOCKED_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/,  // link-local
  /^fc[0-9a-f]{2}:/i,      // ULA IPv6
  /^fe80:/i,                // link-local IPv6
];

export class UrlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UrlValidationError';
  }
}

/**
 * Normalise a URL for storage and deduplication:
 * - force https where http would work (optional)
 * - remove fragment
 * - strip tracking params
 * - lowercase hostname
 * - sort remaining params for stability
 */
export function normaliseUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new UrlValidationError(`Invalid URL: ${rawUrl}`);
  }

  // Only allow http and https
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UrlValidationError(
      `Unsupported URL scheme "${url.protocol}" — only http and https are allowed`,
    );
  }

  if (url.username || url.password) {
    throw new UrlValidationError('URLs containing embedded credentials are not allowed');
  }

  // Lowercase hostname
  url.hostname = url.hostname.toLowerCase();

  // Remove fragment
  url.hash = '';

  // Strip tracking params
  for (const key of [...url.searchParams.keys()]) {
    if (STRIP_PARAMS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }

  // Sort remaining params for stable deduplication
  url.searchParams.sort();

  return url.toString();
}

/**
 * Guard against Server-Side Request Forgery.
 * Throws UrlValidationError if the target host is a private/reserved address.
 * By default, only public internet addresses are allowed.
 */
export function guardSsrf(
  url: string,
  allowList: string[] = [],
): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UrlValidationError(`Cannot parse URL for SSRF check: ${url}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');

  // Allow-list takes precedence
  if (allowList.includes(hostname)) return;

  if (isBlockedAddress(hostname)) {
    throw new UrlValidationError(
      `URL targets a private or reserved address and is not on the allow-list: ${hostname}`,
    );
  }
}

/** Resolve a hostname and reject any non-public result. Call this for every
 * navigation/fetch, including redirects, to prevent DNS-based SSRF. */
export async function guardSsrfResolved(
  url: string,
  allowList: string[] = [],
): Promise<void> {
  guardSsrf(url, allowList);
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  if (allowList.includes(hostname) || isIP(hostname)) return;

  let addresses: Array<{ address: string }>;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('DNS lookup timed out after 10000ms')), 10_000)),
    ]);
  } catch (err: any) {
    throw new UrlValidationError(`Could not resolve hostname ${hostname}: ${err?.message ?? err}`);
  }
  if (addresses.length === 0) {
    throw new UrlValidationError(`Hostname resolved to no addresses: ${hostname}`);
  }
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new UrlValidationError(
        `Hostname ${hostname} resolves to a private or reserved address: ${address}`,
      );
    }
  }
}

export function isBlockedAddress(input: string): boolean {
  const address = input.toLowerCase().replace(/^\[|\]$/g, '');
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(address)) return true;
  }

  // Additional non-public IPv4 ranges.
  const v4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return true;
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      // 192.0.0.0/24 is IETF protocol space and 192.0.2.0/24 is TEST-NET-1.
      // Do not block all of 192.0.0.0/16: public services such as the
      // WordPress.com edge at 192.0.66.239 legitimately occupy that space.
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }

  // Non-public IPv6: unspecified/loopback, IPv4-mapped, ULA, link-local,
  // multicast and documentation prefixes.
  if (address.includes(':')) {
    return (
      address === '::' || address === '::1' ||
      address.startsWith('::ffff:') ||
      address.startsWith('fc') || address.startsWith('fd') ||
      /^fe[89ab]/.test(address) || address.startsWith('ff') ||
      address.startsWith('2001:db8:')
    );
  }

  return false;
}
