# Testing

Packrat uses the Bun test runner and TypeScript's no-emit type check. The current suite contains 128 tests across 14 files.

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
| `tests/assets.test.ts` | Link normalisation, image selection and tracking-pixel removal. |
| `tests/canonical.test.ts` | MHTML detection, MIME decoding and safe rendering. |
| `tests/db.test.ts` | Schema, migrations and database helpers. |
| `tests/epub.test.ts` | EPUB 3 structure and optional `epubcheck` compliance. |
| `tests/features.test.ts` | Deletion, pagination, index actions and Markdown provenance. |
| `tests/markdown.test.ts` | Markdown conversion and offline ZIP export. |
| `tests/overlays.test.ts` | Overlay removal without deleting article content. |
| `tests/phase1.test.ts` | Extraction, sanitisation, storage, readiness and image recovery. |
| `tests/queue.test.ts` | Job lifecycle, attempts, recovery and tags. |
| `tests/sanitize.test.ts` | Hostile HTML input and active-content removal. |
| `tests/upgrade.test.ts` | Migration upgrade and standalone backup restore. |
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
5. the view makes no external requests;
6. the document contains no scripts, forms or frames;
7. the page has no horizontal overflow;
8. `verify --all` passes against the disposable database.

Production data should be backed up and verified before deployment.
