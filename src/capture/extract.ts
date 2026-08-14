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
  /** Set when a text-matched semantic container restores images Readability omitted. */
  imageRecovery: { readabilityImages: number; recoveredImages: number } | null;
  /** Extraction warnings detected while protecting structured article content. */
  extractionWarnings: string[];
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

  // Browser syntax-highlighting plugins often add wrappers such as
  // `code-toolbar` around otherwise valid <pre> blocks. Readability assigns a
  // negative score to class/id values containing "tool" and can delete the
  // complete wrapper, including the sample code. Neutralise only immediate
  // extraction-hostile wrappers on the disposable parsing DOM.
  const protectedCodeBlocks = protectCodeBlocksForReadability(document);

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
    const retainedProtectedCodeBlocks = countRetainedProtectedCodeBlocks(article.content ?? '', protectedCodeBlocks);
    const extractionWarnings = retainedProtectedCodeBlocks < protectedCodeBlocks.length
      ? [`Readability retained ${retainedProtectedCodeBlocks} of ${protectedCodeBlocks.length} code blocks protected from extraction-hostile wrappers`]
      : [];
    return {
      mode: 'article',
      title: article.title ?? ogTitle,
      author: article.byline ?? null,
      siteName: article.siteName ?? ogSiteName,
      publishedAt: ogPublished,
      excerpt: article.excerpt ?? null,
      lang: article.lang ?? htmlLang,
      extractedText: article.textContent?.trim() ?? null,
      ...recoverSemanticArticleImages(rawHtml, article.content ?? '', article.textContent ?? ''),
      extractionWarnings,
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
    imageRecovery: null,
    extractionWarnings: [],
  };
}

/** Neutralise the syntax-highlighter token that makes Readability discard an
 * immediate <pre> wrapper. Preserve unrelated classes and stable IDs. The
 * original rendered snapshot is untouched because parsing created a new DOM. */
function protectCodeBlocksForReadability(document: Document): string[] {
  const protectedBlocks: string[] = [];
  document.querySelectorAll('pre').forEach((pre) => {
    const wrapper = pre.parentElement;
    if (!wrapper) return;
    const classes = (wrapper.getAttribute('class') ?? '').split(/\s+/).filter(Boolean);
    const retainedClasses = classes.filter((className) => className.toLowerCase() !== 'code-toolbar');
    if (retainedClasses.length === classes.length) return;
    if (retainedClasses.length) wrapper.setAttribute('class', retainedClasses.join(' '));
    else wrapper.removeAttribute('class');
    protectedBlocks.push(codeBlockSignature(pre.textContent ?? ''));
  });
  return protectedBlocks;
}

function countRetainedProtectedCodeBlocks(html: string, protectedBlocks: string[]): number {
  if (!protectedBlocks.length) return 0;
  const required = new Map<string, number>();
  for (const signature of protectedBlocks) required.set(signature, (required.get(signature) ?? 0) + 1);
  const { document } = parseHTML(html);
  let retained = 0;
  document.querySelectorAll('pre').forEach((pre) => {
    const signature = codeBlockSignature(pre.textContent ?? '');
    const remaining = required.get(signature) ?? 0;
    if (remaining > 0) {
      retained++;
      required.set(signature, remaining - 1);
    }
  });
  return retained;
}

function codeBlockSignature(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

/** Readability occasionally removes image-heavy figures while retaining the
 * complete article text. In that case, recover the original semantic article
 * container only when its text strongly matches the Readability result. */
export function recoverSemanticArticleImages(
  rawHtml: string,
  readabilityHtml: string,
  readabilityText: string,
): Pick<ExtractResult, 'articleHtml' | 'imageRecovery'> {
  const readabilityImages = countImages(readabilityHtml);
  const targetText = normaliseText(readabilityText);
  if (targetText.length < MIN_ARTICLE_TEXT_LENGTH) {
    return { articleHtml: readabilityHtml, imageRecovery: null };
  }

  const { document } = parseHTML(rawHtml);
  const allCandidates = Array.from(document.querySelectorAll('article, main'))
    .map((element) => {
      const text = normaliseText(element.textContent ?? '');
      const images = element.querySelectorAll('img').length;
      const ratio = text.length / targetText.length;
      const coverage = wordCoverage(targetText, text);
      const semanticBonus = element.tagName.toLowerCase() === 'article' ? 0.05 : 0;
      return { element, text, images, ratio, coverage, score: coverage - Math.abs(1 - ratio) + semanticBonus };
    });
  const textMatches = (candidate: typeof allCandidates[number]) =>
    candidate.ratio >= 0.8 && candidate.ratio <= 1.25 && candidate.coverage >= 0.9;
  const candidates = allCandidates
    .filter((candidate) => {
      if (!textMatches(candidate)) return false;
      if (candidate.images < Math.max(readabilityImages + 2, Math.ceil(readabilityImages * 1.5))) return false;
      if (candidate.element.tagName.toLowerCase() === 'main') {
        const matchingNestedArticle = allCandidates.some((nested) =>
          nested.element.tagName.toLowerCase() === 'article' &&
          candidate.element.contains(nested.element) && textMatches(nested),
        );
        if (matchingNestedArticle) return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score);

  const best = candidates[0];
  if (!best) return { articleHtml: readabilityHtml, imageRecovery: null };
  return {
    articleHtml: best.element.outerHTML,
    imageRecovery: { readabilityImages, recoveredImages: best.images },
  };
}

function countImages(html: string): number {
  const { document } = parseHTML(html);
  return document.querySelectorAll('img').length;
}

function normaliseText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function wordCoverage(target: string, candidate: string): number {
  const targetWords = new Set(target.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  if (targetWords.size === 0) return 0;
  const candidateWords = new Set(candidate.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  let matched = 0;
  for (const word of targetWords) if (candidateWords.has(word)) matched++;
  return matched / targetWords.size;
}
