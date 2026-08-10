/**
 * bun-packrat — URL normalisation and SSRF guard
 */

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

  const hostname = parsed.hostname;

  // Allow-list takes precedence
  if (allowList.includes(hostname)) return;

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new UrlValidationError(
        `URL targets a private or reserved address and is not on the allow-list: ${hostname}`,
      );
    }
  }
}
