import type { Database } from 'bun:sqlite';
import type { CaptureMetadataRow } from './types.js';
import type { CaptureQueryOptions } from './db/index.js';
import { countCaptures, listCaptures, searchCaptures } from './db/index.js';

export interface CaptureIndexPage {
  rows: CaptureMetadataRow[];
  matchingCount: number;
  effectiveOffset: number;
  error: string;
}

/** Resolve one deterministic index page, including invalid-FTS handling and
 * clamping stale/out-of-range offsets to the nearest preceding page. */
export function resolveCaptureIndexPage(
  db: Database,
  query: string,
  filters: CaptureQueryOptions,
): CaptureIndexPage {
  const limit = Math.max(1, filters.limit ?? 50);
  const requestedOffset = Math.max(0, filters.offset ?? 0);
  try {
    const trimmed = query.trim();
    const matchingCount = countCaptures(db, trimmed || null, filters);
    const effectiveOffset = requestedOffset >= matchingCount
      ? (matchingCount > 0 ? Math.floor((matchingCount - 1) / limit) * limit : 0)
      : requestedOffset;
    const effectiveFilters = { ...filters, limit, offset: effectiveOffset };
    const rows = trimmed
      ? searchCaptures(db, trimmed, effectiveFilters)
      : listCaptures(db, effectiveFilters);
    return { rows, matchingCount, effectiveOffset, error: '' };
  } catch (err: any) {
    return {
      rows: [], matchingCount: 0, effectiveOffset: 0,
      error: `Invalid search query: ${err?.message ?? err}`,
    };
  }
}
