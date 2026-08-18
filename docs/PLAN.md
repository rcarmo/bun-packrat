# Implementation plan

Release `v0.2.7` implements canonical MHTML and source-PDF capture, offline reading, the content API, queue recovery, ArchiveBox import and original-PDF enrichment. ArchiveBox hostname cutover and retirement checks remain planned operational work.

Requirements: [PRD.md](PRD.md)

## Phases

### Phase 1 — Database and capture proof ✅

| Task | File(s) | Status |
|---|---|---|
| SQLite schema + FTS5 + triggers | `src/db/migrations/001_initial.sql` | ✅ |
| Migration runner | `src/db/migrate.ts` | ✅ |
| Database helpers | `src/db/index.ts` | ✅ |
| Core types | `src/types.ts` | ✅ |
| Config (env-driven) | `src/config.ts` | ✅ |
| URL normaliser + SSRF guard | `src/capture/url.ts` | ✅ |
| Legacy/article HTML sanitiser | `src/capture/sanitize.ts` | ✅ |
| Legacy asset inliner and image provenance | `src/capture/assets.ts` | ✅ |
| Readability derived-view extractor | `src/capture/extract.ts` | ✅ |
| Playwright canonical MHTML pipeline | `src/capture/pipeline.ts` | ✅ |
| MHTML decoder and safe full-page renderer | `src/capture/canonical.ts` | ✅ |
| HTTP server (serve + submit) | `src/server.ts` | ✅ |
| CLI entry point: capture, import, search, list, export, delete, backup, verify, migrate and status | `src/cli/index.ts` | ✅ |
| Unit tests: schema | `tests/db.test.ts` | ✅ |
| Unit tests: sanitiser | `tests/sanitize.test.ts` | ✅ |
| Unit tests: URL normaliser | `tests/url.test.ts` | ✅ |
| Phase 1 integration test | `tests/phase1.test.ts` | ✅ |

### Phase 2 — Archive application ✅

| Task | File(s) | Status |
|---|---|---|
| In-process job queue (SQLite-backed) | `src/queue/index.ts` | ✅ |
| Job DB helpers (create/claim/finish/recover) | `src/db/index.ts` | ✅ |
| Tag management (add/get/list) | `src/db/index.ts` | ✅ |
| Web UI (search, full filters/sorting, warnings, recapture, export links, pagination) | `src/server.ts` | ✅ |
| HTML export | `src/export/html.ts` | ✅ |
| Markdown + ZIP export | `src/export/markdown.ts` | ✅ |
| EPUB 3 export | `src/export/epub.ts` | ✅ |
| On-demand PDF export via Playwright | `src/export/pdf.ts` | ✅ |
| Export routes on HTTP server | `src/server.ts` | ✅ |
| Agent search/content API (`mhtml`, HTML, Markdown, ZIP, EPUB, rendered PDF and source PDF) | `src/server.ts` | ✅ |
| Tags API | `src/server.ts` | ✅ |
| Freshness reuse, forced recapture, aliases and notes | pipeline, DB, server | ✅ |
| Permanent capture deletion (UI/API/CLI, latest repair, audit preservation) | DB, server, CLI | ✅ |
| Offline simplified Article view with captured images | canonical renderer, server | ✅ |
| Text-oriented Markdown mode with archived same-origin images and privacy-gated remote fallback | capture, DB, export, server | ✅ |
| Matching counts and deterministic paging metadata | DB, server | ✅ |
| Idempotency keys and queued-job cancellation | DB, HTTP API | ✅ |
| HTTP Basic auth required by default | `src/config.ts`, `src/server.ts` | ✅ |
| Capture duration/import counts and machine-readable `/api/status` metrics | `src/server.ts` | ✅ |
| Authenticated human-readable queue monitor at `/status` | `src/server.ts` | ✅ |
| Durable job attempt diagnostics, three-attempt limit and startup recovery | DB, queue | ✅ |
| Bounded DNS/browser waits and process-exit capture watchdog | capture, queue | ✅ |
| `backup` CLI | `src/cli/index.ts` | ✅ |
| `verify` CLI (integrity + content-hash) | `src/cli/index.ts` | ✅ |
| `export` CLI (html / md / epub / pdf) | `src/cli/index.ts` | ✅ |
| Job queue tests | `tests/queue.test.ts` | ✅ |
| Markdown export tests | `tests/markdown.test.ts` | ✅ |
| EPUB export tests | `tests/epub.test.ts` | ✅ |

### Phase 3 — ArchiveBox importer ✅

Implemented and rehearsed against the complete ArchiveBox collection on VM 119:

- read-only discovery against `index.sqlite3` and snapshot directories;
- versioned `archivebox-django-core-v1` schema adapter;
- bounded candidate order: `singlefile.html` → rendered `output.html` → metadata-only;
- offline normalisation with active content and unresolved resources removed;
- durable per-snapshot checkpoints and `--retry-failed` resumption;
- exact canonical-body deduplication with auditable provenance;
- JSON and HTML reconciliation reports;
- CLI dry-run, import, status and verification operations;
- original-PDF enrichment from verified successful `wget` responses, with independent resumable outcomes.

The full rehearsal reconciled 2,690 source snapshots as 2,688 imports and two exact duplicates. The deployed database later passed SQLite integrity and 1,259 stored-content hash checks after PDF enrichment and the `v0.2.7` upgrade.

### Phase 4 — EPUB and print ✅

| Task | Status |
|---|---|
| EPUB 3 builder — pure Bun ZIP, adapted from `rcarmo/bun-readlater-epub` | ✅ |
| Asset extraction from stored data: URLs into EPUB manifest | ✅ |
| Archive header stripped from EPUB article body | ✅ |
| On-demand rendered PDF via Playwright print CSS — no file retained | ✅ |
| Byte-exact direct source-PDF storage, range delivery and bounded PDF.js extraction | ✅ |
| Cover-image metadata when a suitable embedded image exists | ✅ |
| Real `epubcheck` release validation (conditional test) | ✅ |
| EPUB suite (structure, mimetype offset, spec compliance, epubcheck) | ✅ |

### Phase 5 — Cutover 🔜

Import, PDF enrichment, reconciliation and clean-instance backup/restore verification are complete. ArchiveBox is stopped and its storage remains available read-only.

Remaining steps:
1. Redirect local `archivebox.local` / `archivebox` hostname to the Packrat service.
2. Validate the service and rollback path during the agreed rollback period.
3. Retire the ArchiveBox VM after the rollback checks pass.

---

## Directory structure

```
bun-packrat/
├── docs/
│   ├── README.md                      # documentation index
│   ├── architecture.md                # system and data flow
│   ├── api.md                         # HTTP API reference
│   ├── cli.md                         # command-line reference
│   ├── configuration.md               # environment contract
│   ├── deployment.md                  # Docker and local setup
│   ├── operations.md                  # backup, restore and recovery
│   ├── testing.md                     # test and acceptance gates
│   ├── PLAN.md                        # implementation status
│   └── PRD.md                         # requirements baseline
├── src/
│   ├── capture/
│   │   ├── assemble.ts                # legacy HTML archive shell
│   │   ├── assets.ts                  # legacy inlining + image provenance
│   │   ├── canonical.ts               # MHTML detection, decoding and safe rendering
│   │   ├── extract.ts                 # Mozilla Readability derived extraction
│   │   ├── overlays.ts                # conservative overlay cleanup
│   │   ├── pipeline.ts                # Playwright + CDP MHTML orchestration
│   │   ├── sanitize.ts                # allow-list HTML sanitiser
│   │   └── url.ts                     # URL normalisation + SSRF guard
│   ├── cli/
│   │   └── index.ts                   # CLI: capture, search, list, export, backup, verify, status
│   ├── db/
│   │   ├── index.ts                   # open DB, migrations, typed query helpers
│   │   ├── migrate.ts                 # standalone migration runner
│   │   └── migrations/
│   │       ├── 001_initial.sql        # schema: 11 tables, FTS5, triggers
│   │       ├── 002_constraints.sql    # claim/tag indexes + FTS rebuild
│   │       ├── 003_application_features.sql # notes/errors/duration + indexes
│   │       ├── 004_query_indexes.sql        # filtered browsing/history indexes
│   │       ├── 005_capture_body_metadata.sql # body format metadata + FTS trigger updates
│   │       └── 006_source_pdfs.sql          # source PDFs, extraction + enrichment state
│   ├── export/
│   │   ├── epub.ts                    # EPUB 3 builder (pure Bun ZIP)
│   │   ├── html.ts                    # HTML export helper
│   │   ├── markdown.ts                # HTML → Markdown view + ZIP packager
│   │   ├── render-markdown.ts         # safe generated-Markdown renderer
│   │   └── pdf.ts                     # Playwright print → PDF
│   ├── import/
│   │   ├── archivebox.ts              # read-only ArchiveBox adapter and resumable importer
│   │   └── archivebox-pdf.ts          # original-PDF classifier and enrichment pass
│   ├── pdf/                           # source-PDF validation, storage and extraction worker
│   ├── queue/
│   │   └── index.ts                   # JobQueue: SQLite-backed in-process poller
│   ├── config.ts                      # env-driven config with defaults
│   ├── server.ts                      # HTTP server entry point
│   └── types.ts                       # shared TypeScript types
├── tests/
│   ├── db.test.ts                     # schema, migrations, query helpers
│   ├── api.test.ts                    # agent search/content API integration tests
│   ├── archivebox-import.test.ts      # discovery, conversion, fallback, resumption, deduplication
│   ├── archivebox-pdf.test.ts         # original-PDF enrichment and verification
│   ├── canonical.test.ts              # MHTML detection, decoding and safe rendering
│   ├── epub.test.ts                   # EPUB 3 export (structure + spec compliance)
│   ├── features.test.ts               # delete/paging/Markdown provenance
│   ├── markdown.test.ts               # Markdown + ZIP export
│   ├── pdf.test.ts                    # source-PDF capture, extraction and delivery
│   ├── phase1.test.ts                 # Phase 1 integration pipeline
│   ├── assets.test.ts                 # link normalisation + tracking pixels
│   ├── overlays.test.ts               # preserve newsletter article content
│   ├── queue.test.ts                  # job lifecycle + tag management
│   ├── sanitize.test.ts               # HTML sanitiser (hostile-input)
│   ├── upgrade.test.ts                # migration upgrade + backup restore
│   └── url.test.ts                    # URL normaliser + SSRF guard
├── docker/
│   └── entrypoint.sh                  # PUID/PGID drop-privileges + /config/.env sourcing
├── .dockerignore
├── .gitignore
├── Dockerfile                         # oven/bun:1.3 + Chromium headless-shell baked in
├── Makefile                           # build / run / stop / logs / shell / clean
├── README.md                          # concise project entry point
├── bun.lock
├── docker-compose.yml                 # /data + /config volumes, shm_size, healthcheck
├── package.json
└── tsconfig.json
```

---

## Open decisions

| # | Decision | Status |
|---|---|---|
| 1 | HTML storage format: raw UTF-8 vs gzip vs zstd | Wired up (none/gzip via `PACKRAT_HTML_COMPRESSION`); zstd deferred pending Bun native support |
| 2 | Body deduplication: one body row per content hash or per-capture | ArchiveBox import reuses an existing capture for exact canonical hashes and records `duplicate`; ordinary captures remain one body per row |
| 3 | Maximum captured-page and per-asset size | Defaults set (20 MB page, 5 MB asset); configurable via env |
| 4 | Freshness interval before a repeated submission creates a new capture | Implemented; 24h default via `PACKRAT_FRESHNESS_SECONDS`, forced recapture available |
| 5 | Authenticated captures | Basic authentication required by default; capture-session credential injection remains deferred |
| 6 | Local archived-link rewriting | Not implemented; no current phase schedules it |
| 7 | EPUB backend: pure Bun vs external converter | Resolved: pure Bun ZIP, no external tools required |
| 8 | Service hostname | `packrat` / `packrat.local`; cutover in Phase 5 |
