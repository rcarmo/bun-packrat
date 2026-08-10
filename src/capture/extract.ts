/**
 * bun-packrat — content extractor
 *
 * Uses Mozilla Readability to extract article-like content from a rendered
 * DOM. Falls back to full-page mode if extraction fails or yields too little
 * text.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import type { CaptureMode } from '../types.js';

export interface ExtractResult {
  mode: CaptureMode;
  title: string | null;
  author: string | null;
  siteName: string | null;
  publishedAt: string | null;
  excerpt: string | null;
  lang: string | null;
  extractedText: string | null;
  /** The article body HTML, or null if full-page mode */
  articleHtml: string | null;
}

/** Minimum text length for a Readability result to be considered useful */
const MIN_ARTICLE_TEXT_LENGTH = 200;

/**
 * Try Readability extraction on the raw HTML.
 * Returns article content when feasible, otherwise signals full-page mode.
 */
export function extractContent(rawHtml: string, url: string): ExtractResult {
  const { document } = parseHTML(rawHtml);

  // Readability requires a real-ish document URL to resolve links
  let docUrl: URL;
  try {
    docUrl = new URL(url);
  } catch {
    docUrl = new URL('https://unknown.invalid/');
  }

  // Grab metadata from <head> before Readability potentially strips it
  const ogTitle =
    document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null;
  const ogSiteName =
    document.querySelector('meta[property="og:site_name"]')?.getAttribute('content') ?? null;
  const ogPublished =
    document.querySelector('meta[property="article:published_time"]')?.getAttribute('content') ??
    document.querySelector('meta[name="date"]')?.getAttribute('content') ??
    document.querySelector('time[datetime]')?.getAttribute('datetime') ??
    null;
  const htmlLang =
    document.documentElement.getAttribute('lang') ??
    document.querySelector('html')?.getAttribute('lang') ??
    null;

  // Attempt Readability extraction
  let reader: Readability | null = null;
  let article: ReturnType<Readability['parse']> | null = null;

  try {
    reader = new Readability(document as unknown as Document, {
      charThreshold: MIN_ARTICLE_TEXT_LENGTH,
    });
    article = reader.parse();
  } catch (err: any) {
    // Readability can throw on unusual DOMs
    article = null;
  }

  if (
    article &&
    article.textContent &&
    article.textContent.trim().length >= MIN_ARTICLE_TEXT_LENGTH
  ) {
    return {
      mode: 'article',
      title: article.title ?? ogTitle,
      author: article.byline ?? null,
      siteName: article.siteName ?? ogSiteName,
      publishedAt: ogPublished,
      excerpt: article.excerpt ?? null,
      lang: article.lang ?? htmlLang,
      extractedText: article.textContent?.trim() ?? null,
      articleHtml: article.content ?? null,
    };
  }

  // Fallback: full-page mode — just grab metadata
  const pageTitle =
    ogTitle ??
    document.querySelector('title')?.textContent?.trim() ??
    null;

  const pageText = document.body?.textContent?.trim() ?? null;

  return {
    mode: 'full_page',
    title: pageTitle,
    author: null,
    siteName: ogSiteName,
    publishedAt: ogPublished,
    excerpt: pageText ? pageText.slice(0, 300) : null,
    lang: htmlLang,
    extractedText: pageText ? pageText.slice(0, 50_000) : null,
    articleHtml: null,
  };
}
