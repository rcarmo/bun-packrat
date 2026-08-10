# bun-packrat — Implementation Plan

Project path: `/workspace/projects/bun-packrat`  
PRD: `docs/PRD.md`  
Status: Phase 1 in progress

## Phases

### Phase 1 — Database and capture proof ← current

**Goal:** prove that a URL can be captured, sanitised, stored in SQLite, and served to desktop and iOS Safari with zero unapproved network requests.

| Task | File(s) | Status |
|---|---|---|
| SQLite schema + FTS5 | `src/db/migrations/001_initial.sql` | ✅ |
| Migration runner | `src/db/migrate.ts` | ✅ |
| Database helpers | `src/db/index.ts` | ✅ |
| Core types | `src/types.ts` | ✅ |
| Config | `src/config.ts` | ✅ |
| URL normaliser | `src/capture/url.ts` | ✅ |
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

**Phase 1 acceptance:**  
- `bun run src/cli/index.ts capture <url>` stores a capture in SQLite  
- `bun run src/server.ts` serves it at `http://localhost:3047/captures/<id>`  
- Opening in Safari causes no external network requests  
- `bun test` passes  

### Phase 2 — Archive application

- Job queue (in-process, persisted to SQLite)
- Web UI: index, search, filters, tags, capture history
- Backup / restore / verify CLI commands
- HTML and Markdown+ZIP exports

### Phase 3 — ArchiveBox importer

- Read-only discovery against `index.sqlite3`
- Versioned schema adapters (ArchiveBox 0.7.x, dev)
- SingleFile validation and normalisation
- Resumable batch import with deduplication
- Reconciliation report (JSON + HTML)

### Phase 4 — EPUB and print

- EPUB 3 from stored HTML (starting from `rcarmo/bun-readlater-epub`)
- On-demand Playwright PDF, no retention
- `epubcheck` in CI; Apple Books smoke test

### Phase 5 — Cutover

- Freeze ArchiveBox writes
- Final incremental import + reconciliation
- Backup + restore verification on clean instance
- Hostname redirect; rollback period

## Directory structure

```
bun-packrat/
├── docs/
│   └── PRD.md                  # requirements baseline
├── src/
│   ├── db/
│   │   ├── index.ts            # open/init database, typed query helpers
│   │   ├── migrate.ts          # CLI migration runner
│   │   └── migrations/
│   │       └── 001_initial.sql # schema + FTS5 + indexes
│   ├── capture/
│   │   ├── url.ts              # URL normalisation, SSRF guard
│   │   ├── sanitize.ts         # allow-list HTML sanitiser
│   │   ├── assets.ts           # fetch + inline assets as data: URLs
│   │   ├── extract.ts          # Readability article extraction
│   │   ├── pipeline.ts         # Playwright orchestration
│   │   └── assemble.ts         # assemble final self-contained HTML
│   ├── server/
│   │   └── routes.ts           # HTTP route handlers
│   ├── export/                 # (Phase 2+) html, md, epub, pdf
│   ├── import/                 # (Phase 3) ArchiveBox importer
│   ├── cli/
│   │   └── index.ts            # CLI entry (capture, search, backup…)
│   ├── config.ts               # env-driven config with defaults
│   ├── types.ts                # shared TypeScript types
│   └── server.ts               # HTTP server entry point
├── tests/
│   ├── db.test.ts
│   ├── sanitize.test.ts
│   ├── url.test.ts
│   └── phase1.test.ts
├── PLAN.md                     # this file
├── README.md
├── package.json
├── tsconfig.json
└── .gitignore
```

## Open decisions (from PRD)

1. **HTML storage format** — benchmark raw UTF-8 vs gzip vs zstd before committing; wire up the choice via config  
2. **Body deduplication** — single body row per content hash vs per-capture storage; decide at Phase 2  
3. **Max page/asset size** — default 20 MB page, 5 MB per asset; configurable  
4. **Freshness interval** — default 24 h before recapture; configurable  
5. **Authenticated captures** — not in Phase 1  
6. **Local link rewriting** — opt-in, Phase 2  
7. **EPUB backend** — port from bun-readlater-epub; decide pure-Bun vs epubcheck pass  
8. **Service name/hostname** — `packrat` / `packrat.local`  
