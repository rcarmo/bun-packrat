# Testing

Packrat uses the Bun test runner and TypeScript's no-emit type check. The v0.3.0 release gate contains 178 tests across 19 files, including oversized-MHTML, mixed-codec and storage-migration coverage.

## Full gate

```bash
bun run typecheck
bun test
git diff --check
```

The EPUB suite calls `epubcheck` when it is installed. The compliance test skips when the command is unavailable.

## Test files

| File | Scope |
|---|---|
| `tests/api.test.ts` | Search and content HTTP API. |
| `tests/archivebox-import.test.ts` | Read-only inventory, offline conversion, fallback, resumption and deduplication. |
| `tests/archivebox-pdf.test.ts` | Original-PDF classification, enrichment, verification and resumption. |
| `tests/assets.test.ts` | Link normalisation, image selection and tracking-pixel removal. |
| `tests/canonical.test.ts` | MHTML detection, MIME decoding, raster-part rewriting, body codecs and safe rendering. |
| `tests/db.test.ts` | Schema, migrations and database helpers. |
| `tests/epub.test.ts` | EPUB 3 structure and optional `epubcheck` compliance. |
| `tests/features.test.ts` | Deletion, pagination, index actions and Markdown provenance. |
| `tests/markdown.test.ts` | Markdown conversion and offline ZIP export. |
| `tests/overlays.test.ts` | Overlay removal without deleting article content. |
| `tests/pdf.test.ts` | Direct-PDF capture, bounded extraction, deduplication and range delivery. |
| `tests/phase1.test.ts` | Extraction, sanitisation, storage, readiness and image recovery. |
| `tests/queue.test.ts` | Job lifecycle, attempts, recovery and tags. |
| `tests/sanitize.test.ts` | Hostile HTML input and active-content removal. |
| `tests/upgrade.test.ts` | Schema upgrade, advantageous storage migration, interruption/resumption and standalone backup restore. |
| `tests/url.test.ts` | URL normalisation and SSRF address classification. |

Run one file while developing:

```bash
bun test tests/canonical.test.ts
```

## Browser acceptance checks

Unit tests do not replace live capture checks. Before changing capture readiness, MHTML decoding or Article rendering, use a disposable database and verify:

1. the target URL produces a successful canonical capture;
2. the stored SHA-256 matches downloaded MHTML bytes;
3. the Article route returns `200` at phone, tablet and desktop widths;
4. captured images use embedded `data:` URLs;
5. the full-page and Article views make no external requests;
6. the Markdown reader uses authenticated same-origin archived-image routes where bytes are available;
7. missing Markdown images remain blocked unless remote fallback is enabled explicitly;
8. the document contains no scripts, forms or frames;
9. the page has no horizontal overflow;
10. `verify --all` passes against the disposable database.

### v0.3.0 capture and storage checks

The release gate must also prove:

1. MHTML within `PACKRAT_MAX_PAGE_BYTES` remains byte-exact before storage compression;
2. colour WebP quality 75 is the first oversized fallback;
3. greyscale WebP quality 75 runs only when the colour candidate remains oversized;
4. an image part is replaced only when its encoded bytes are smaller;
5. SVG, GIF and non-image parts remain unchanged;
6. MIME boundaries, locations and content types remain valid after rewriting;
7. a fallback that cannot fit stores no body;
8. `none`, `gzip` and `zstd` rows decode to identical canonical bytes;
9. new bodies store zstd only when it is smaller;
10. migration verifies the existing hash and updates only advantageous rows;
11. interrupted migration reruns without damaging completed or retained rows;
12. a representative oversized capture stays within the 2 GiB production profile;
13. `--no-orphans` removes Chromium descendants after watchdog exit.

Production data must be backed up and verified before deployment or storage migration.
