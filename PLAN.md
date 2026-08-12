# bun-packrat — Implementation Plan

Project path: `/workspace/projects/bun-packrat`  
PRD: `docs/PRD.md`  
Status: **All actionable non-ArchiveBox scope complete — 84 tests passing across 9 files; Phases 3 and 5 deferred**

---

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
| HTML sanitiser (allow-list) | `src/capture/sanitize.ts` | ✅ |
| Asset inliner (data: URLs) | `src/capture/assets.ts` | ✅ |
| Readability extractor | `src/capture/extract.ts` | ✅ |
| Playwright capture pipeline | `src/capture/pipeline.ts` | ✅ |
| Self-contained HTML assembler | `src/capture/assemble.ts` | ✅ |
| HTTP server (serve + submit) | `src/server.ts` | ✅ |
| CLI entry point | `src/cli/index.ts` | ✅ |
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
| Tags API | `src/server.ts` | ✅ |
| Freshness reuse, forced recapture, aliases and notes | pipeline, DB, server | ✅ |
| Idempotency keys and queued-job cancellation | DB, HTTP API | ✅ |
| HTTP Basic auth required by default | `src/config.ts`, `src/server.ts` | ✅ |
| Capture duration/import counts/status metrics | `src/server.ts` | ✅ |
| Durable job attempt diagnostics and retry limits | DB, queue | ✅ |
| `backup` CLI | `src/cli/index.ts` | ✅ |
| `verify` CLI (integrity + content-hash) | `src/cli/index.ts` | ✅ |
| `export` CLI (html / md / epub / pdf) | `src/cli/index.ts` | ✅ |
| Job queue tests | `tests/queue.test.ts` | ✅ |
| Markdown export tests | `tests/markdown.test.ts` | ✅ |
| EPUB export tests | `tests/epub.test.ts` | ✅ |

### Phase 3 — ArchiveBox importer 🔜

Blocked on cutover decision. Live ArchiveBox instance (`192.168.1.123`, VMID 119 on `tnas`) is shut down and read-only.

Planned work:
- Read-only discovery pass against ArchiveBox `index.sqlite3`
- Versioned schema adapters (ArchiveBox 0.7.x, dev)
- Candidate priority: `singlefile.html` → rendered HTML → original response → WARC → metadata-only
- Resumable batch import with atomic checkpoints
- Deduplication by content hash
- Full reconciliation report (JSON + HTML) — every source snapshot gets one terminal outcome
- `archive import archivebox --data-root <path>` CLI command

### Phase 4 — EPUB and print ✅

| Task | Status |
|---|---|
| EPUB 3 builder — pure Bun ZIP, adapted from `rcarmo/bun-readlater-epub` | ✅ |
| Asset extraction from stored data: URLs into EPUB manifest | ✅ |
| Archive header stripped from EPUB article body | ✅ |
| On-demand PDF via Playwright print CSS — no file retained | ✅ |
| Cover-image metadata when a suitable embedded image exists | ✅ |
| Real `epubcheck` release validation (conditional test) | ✅ |
| EPUB suite (structure, mimetype offset, spec compliance, epubcheck) | ✅ |

### Phase 5 — Cutover 🔜

Prerequisites: Phase 3 reconciliation passes; new database backed up and restored on a clean instance.

Steps:
1. Freeze ArchiveBox writes (VM already stopped)
2. Run final incremental import + reconciliation report
3. Backup new SQLite database; restore on clean instance; verify
4. Redirect local `archivebox.local` / `archivebox` hostname to packrat service
5. Keep ArchiveBox storage read-only through agreed rollback period
6. Retire ArchiveBox VM after rollback period

---

## Directory structure

```
bun-packrat/
├── docs/
│   └── PRD.md                         # requirements baseline
├── src/
│   ├── capture/
│   │   ├── assemble.ts                # archive header + CSS → self-contained HTML
│   │   ├── assets.ts                  # fetch external assets → data: URLs
│   │   ├── extract.ts                 # Mozilla Readability extraction
│   │   ├── pipeline.ts                # Playwright orchestration
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
│   │       └── 003_application_features.sql # notes/errors/duration + indexes
│   ├── export/
│   │   ├── epub.ts                    # EPUB 3 builder (pure Bun ZIP)
│   │   ├── html.ts                    # HTML export helper
│   │   ├── markdown.ts                # HTML → Markdown + ZIP packager
│   │   └── pdf.ts                     # Playwright print → PDF
│   ├── import/                        # (Phase 3) ArchiveBox importer — not yet implemented
│   ├── queue/
│   │   └── index.ts                   # JobQueue: SQLite-backed in-process poller
│   ├── config.ts                      # env-driven config with defaults
│   ├── server.ts                      # HTTP server entry point
│   └── types.ts                       # shared TypeScript types
├── tests/
│   ├── db.test.ts                     # schema, migrations, query helpers
│   ├── epub.test.ts                   # EPUB 3 export (structure + spec compliance)
│   ├── markdown.test.ts               # Markdown + ZIP export
│   ├── phase1.test.ts                 # Phase 1 integration pipeline
│   ├── assets.test.ts                 # link normalisation + tracking pixels
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
├── PLAN.md                            # this file
├── README.md
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
| 2 | Body deduplication: one body row per content hash or per-capture | Deferred to Phase 3; current schema stores one body per capture row |
| 3 | Maximum captured-page and per-asset size | Defaults set (20 MB page, 5 MB asset); configurable via env |
| 4 | Freshness interval before a repeated submission creates a new capture | Implemented; 24h default via `PACKRAT_FRESHNESS_SECONDS`, forced recapture available |
| 5 | Authenticated captures | Basic authentication required by default; capture-session credential injection remains deferred |
| 6 | Local archived-link rewriting | Not yet implemented; planned for Phase 2 polish or Phase 3 |
| 7 | EPUB backend: pure Bun vs external converter | Resolved: pure Bun ZIP, no external tools required |
| 8 | Service hostname | `packrat` / `packrat.local`; cutover in Phase 5 |
