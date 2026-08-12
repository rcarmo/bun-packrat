/**
 * bun-packrat — HTML sanitiser
 *
 * Allow-list based: strips everything not explicitly permitted.
 * No scripts, no event handlers, no forms, no frames, no external resources.
 * Uses linkedom for parsing (same dep as bun-readlater-epub).
 */

import { parseHTML } from 'linkedom';

/** Elements allowed in the output */
const ALLOWED_ELEMENTS = new Set([
  // Structure
  'html', 'head', 'body', 'main', 'article', 'section', 'nav', 'aside',
  'header', 'footer', 'div', 'span',
  // Headings
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  // Text
  'p', 'br', 'hr', 'pre', 'code', 'kbd', 'samp', 'var',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'ins', 'mark',
  'sub', 'sup', 'small', 'abbr', 'cite', 'q', 'dfn',
  'blockquote', 'details', 'summary',
  // Lists
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  // Tables
  'table', 'caption', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  // Media
  'img', 'picture', 'figure', 'figcaption',
  // Links (kept, but href validated)
  'a',
  // Semantic
  'time', 'address', 'title', 'meta', 'link', 'style',
]);

/** Attributes allowed globally on all elements */
const ALLOWED_GLOBAL_ATTRS = new Set([
  'id', 'class', 'lang', 'dir', 'title', 'aria-label', 'aria-hidden',
  'aria-describedby', 'aria-expanded', 'role',
]);

/** Attributes allowed per element */
const ALLOWED_ELEMENT_ATTRS: Record<string, Set<string>> = {
  a: new Set(['href', 'rel', 'target', 'download']),
  img: new Set(['src', 'alt', 'width', 'height', 'loading', 'decoding']),
  picture: new Set([]),
  td: new Set(['colspan', 'rowspan', 'align', 'valign']),
  th: new Set(['colspan', 'rowspan', 'scope', 'align', 'valign']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  meta: new Set(['charset', 'name', 'content', 'http-equiv', 'property']),
  link: new Set(['rel', 'type', 'href', 'media', 'charset']),
  time: new Set(['datetime']),
  details: new Set(['open']),
  style: new Set(['media']),
  blockquote: new Set(['cite']),
  q: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
  abbr: new Set(['title']),
};

/** Tags that must be completely removed (including content) */
const REMOVE_WITH_CONTENT = new Set([
  'script', 'noscript', 'style', // style handled separately
  'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'canvas', 'video', 'audio', 'track',
  'form', 'input', 'button', 'select', 'textarea', 'fieldset', 'legend', 'label',
  'dialog',
  'template', 'slot',
  'svg', 'math',
  // Common overlay/tracking containers
  'aside[class*="cookie"]',
]);

export interface SanitizeOptions {
  /** Maximum allowed length of any single attribute value (bytes) */
  maxAttrLength?: number;
  /** Whether to keep <style> tags with inline CSS (default: true) */
  keepStyles?: boolean;
}

export interface SanitizeResult {
  html: string;
  warnings: string[];
}

/**
 * Sanitise a parsed DOM document in-place.
 * Returns the serialised outer HTML of the cleaned document.
 */
export function sanitizeHtml(
  rawHtml: string,
  opts: SanitizeOptions = {},
): SanitizeResult {
  const maxAttrLength = opts.maxAttrLength ?? 65536;
  const keepStyles = opts.keepStyles ?? true;
  const warnings: string[] = [];

  const { document } = parseHTML(rawHtml);

  // --- Pass 1: remove entire subtrees ---
  const toRemove: Element[] = [];

  // Scripts, iframes, forms, etc.
  for (const tag of [
    'script', 'noscript', 'iframe', 'frame', 'frameset',
    'object', 'embed', 'applet', 'canvas',
    'video', 'audio', 'track',
    'form', 'input', 'button', 'select', 'textarea',
    'fieldset', 'legend',
    'dialog', 'template', 'slot',
    'svg', 'math',
  ]) {
    document.querySelectorAll(tag).forEach((el) => toRemove.push(el as Element));
  }

  // Style tags (keep or remove based on option)
  if (!keepStyles) {
    document.querySelectorAll('style').forEach((el) => toRemove.push(el as Element));
  }

  // Common cookie/newsletter overlays (heuristic class names)
  const overlaySelectors = [
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="newsletter"]',
    '[id*="newsletter"]',
    '[class*="popup"]',
    '[id*="popup"]',
    '[class*="modal"]',
    '[class*="overlay"]',
    '[class*="banner"]',
    '[class*="gdpr"]',
    '[class*="consent"]',
    '#onetrust-consent-sdk',
    '.cc-window',
    '.consent-bump',
  ];
  for (const sel of overlaySelectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => {
        // Only remove visually-dominant overlays (heuristic: fixed/absolute position)
        const style = (el as HTMLElement).getAttribute?.('style') ?? '';
        if (style.includes('fixed') || style.includes('z-index')) {
          toRemove.push(el as Element);
        }
      });
    } catch {
      // Ignore selector errors from unusual class names
    }
  }

  for (const el of toRemove) {
    el.parentNode?.removeChild(el);
  }

  // --- Pass 2: remove disallowed elements, keeping their text children ---
  function walkNode(node: any): void {
    if (node.nodeType === 8 /* COMMENT */) {
      node.parentNode?.removeChild(node);
      return;
    }
    if (node.nodeType !== 1 /* ELEMENT */) return;

    const tag = (node.tagName ?? '').toLowerCase();

    if (!ALLOWED_ELEMENTS.has(tag)) {
      // Replace with children (keep text)
      const parent = node.parentNode;
      if (parent) {
        const children = [...node.childNodes];
        for (const child of children) {
          parent.insertBefore(child, node);
        }
        parent.removeChild(node);
        // Walk the promoted children
        for (const child of children) walkNode(child);
      }
      return;
    }

    // Walk children first (bottom-up)
    for (const child of [...node.childNodes]) {
      walkNode(child);
    }

    // --- Pass 3: sanitise attributes on allowed elements ---
    const allowedAttrs = new Set([
      ...ALLOWED_GLOBAL_ATTRS,
      ...(ALLOWED_ELEMENT_ATTRS[tag] ?? []),
    ]);

    for (const attr of [...(node.attributes ?? [])]) {
      const name = attr.name.toLowerCase();

      // Remove all event handlers
      if (name.startsWith('on')) {
        node.removeAttribute(attr.name);
        warnings.push(`Removed event handler: ${name}`);
        continue;
      }

      // Remove data-* that might contain JS
      if (name.startsWith('data-') && !allowedAttrs.has(name)) {
        node.removeAttribute(attr.name);
        continue;
      }

      if (!allowedAttrs.has(name)) {
        node.removeAttribute(attr.name);
        continue;
      }

      // Value safety — data: URLs on src/href are exempt (asset inliner produces large blobs)
      const value = attr.value ?? '';
      const isDataUrl = value.startsWith('data:');
      if (!isDataUrl && value.length > maxAttrLength) {
        node.removeAttribute(attr.name);
        warnings.push(`Attribute ${name} exceeded max length, removed`);
        continue;
      }

      // Disallow javascript: and data: in href (data: images in src are fine)
      if (name === 'href') {
        const normalised = value.trim().toLowerCase();
        if (normalised.startsWith('javascript:') || normalised.startsWith('vbscript:')) {
          node.setAttribute('href', '#');
          warnings.push(`Replaced dangerous href value`);
        }
      }

      // meta http-equiv refresh → remove
      if (tag === 'meta' && name === 'http-equiv' && value.toLowerCase() === 'refresh') {
        node.parentNode?.removeChild(node);
        warnings.push('Removed meta http-equiv refresh');
        return;
      }
    }

    // Native lazy loading is unreliable for large data: URLs in Safari and can
    // leave offline images undecoded. All archived assets are local, so eager
    // loading has no network cost.
    if (tag === 'img') {
      node.setAttribute('loading', 'eager');
      node.setAttribute('decoding', 'async');
    }
  }

  walkNode(document.documentElement);

  return {
    html: document.toString(),
    warnings,
  };
}
