# bun-packrat

A single-file web archive service. Each capture is a self-contained, sanitised HTML document stored in SQLite and served directly to desktop and iOS Safari. Markdown, EPUB and PDF are derived on demand.

Replaces a 35 GB / 130,000-file ArchiveBox deployment with one SQLite database and one service process.

## Status

Phases 1, 2 and 4 are complete. 63 tests passing.

| Phase | Scope | Status |
|---|---|---|
| 1 | Database schema, Playwright capture, sanitiser, assembler, HTTP server, CLI | ✅ complete |
| 2 | Job queue, tag management, web UI, HTML/MD/EPUB/PDF exports, backup/verify | ✅ complete |
| 3 | ArchiveBox mass importer (read-only source, resumable, reconciliation report) | 🔜 planned |
| 4 | EPUB 3 (adapted from bun-readlater-epub), on-demand PDF — no retention | ✅ complete |
| 5 | Cutover: freeze ArchiveBox, final import, hostname redirect, rollback period | 🔜 planned |

See [docs/PRD.md](docs/PRD.md) for full requirements.  
See [PLAN.md](PLAN.md) for the implementation plan and open decisions.

---

## Quick start

### Docker (recommended)

```bash
# Build image (Chromium baked in — first build takes a few minutes)
make up

# Or step by step:
docker compose build
mkdir -p data config
docker compose up -d

# Open the archive index
open http://localhost:3047/
```

**Volumes:**

| Host path | Container path | Purpose |
|---|---|---|
| `./data` | `/data` | SQLite database (`packrat.db`) — the only backup target |
| `./config` | `/config` (read-only) | Optional `.env` file to override any environment variable |

**Optional `config/.env`:**

```dotenv
PACKRAT_BASE_URL=http://packrat.local
PACKRAT_HTML_COMPRESSION=gzip
PACKRAT_MAX_CONCURRENT_CAPTURES=3
PUID=1000
PGID=1000
```

The image is ~500 MB (Chromium headless-shell included). No browser download at container start.

### Local development (Bun required)

```bash
bun install

# Start the server (creates ./data/packrat.db on first run)
PACKRAT_DB=./data/packrat.db bun run src/server.ts

# Run the tests
bun test

# Archive a URL from the CLI
bun run src/cli/index.ts capture https://example.com/article
```

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PACKRAT_DB` | `./data/packrat.db` | SQLite database path |
| `PORT` | `3047` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `PACKRAT_BASE_URL` | `http://localhost:3047` | Service base URL (used in CLI output) |
| `PLAYWRIGHT_BROWSERS_PATH` | `/browsers` (Docker) or `/workspace/bin/pw-browsers` (local) | Playwright browser directory |
| `PACKRAT_CAPTURE_TIMEOUT_MS` | `60000` | Per-capture browser timeout (ms) |
| `PACKRAT_MAX_CONCURRENT_CAPTURES` | `2` | Parallel capture workers |
| `PACKRAT_MAX_PAGE_BYTES` | `20971520` | Maximum stored page size (20 MB) |
| `PACKRAT_MAX_ASSET_BYTES` | `5242880` | Maximum asset size to inline as data: URL (5 MB) |
| `PACKRAT_HTML_COMPRESSION` | `none` | Stored HTML compression: `none` or `gzip` |

---

## HTTP API

### Captures

```
POST   /api/captures
       Body: { "url": "https://..." }
       Response: 202 { "message": "Capture queued", "jobId": N, "url": "..." }

GET    /api/captures
       Query: q (FTS query), limit (default 50, max 200), offset
       Response: { "captures": [...] }

GET    /api/captures/:id
       Response: capture metadata JSON (add ?meta to force JSON on browser requests)

GET    /captures/:id
       Response: archived HTML with restrictive CSP (no external requests)
```

### Exports

All export endpoints stream the file and return it as an attachment. No file is retained server-side after the response.

```
GET    /captures/:id/export/html   → self-contained HTML file
GET    /captures/:id/export/md     → ZIP: article.md + metadata.json + assets/
GET    /captures/:id/export/epub   → EPUB 3 file
GET    /captures/:id/export/pdf    → PDF via Playwright print CSS (generated on demand)
```

### Tags

```
GET    /api/tags
       Response: { "tags": [{ "name": "...", "count": N }, ...] }

GET    /api/captures/:id/tags
       Response: { "tags": ["tag1", "tag2"] }

POST   /api/captures/:id/tags
       Body: { "tag": "name" }
       Response: { "ok": true, "tag": "name" }
```

### Jobs and status

```
GET    /api/jobs/:id
       Response: job row (status, result, error, attempt_count, timestamps)

GET    /api/status
       Response: { "status": "ok", "captures": {...}, "jobQueue": {...}, "dbSizeMb": "..." }
```

---

## CLI

```
bun run src/cli/index.ts <command> [args]
```

| Command | Description |
|---|---|
| `capture <url>` | Archive a URL (blocking, JSON output) |
| `search <query>` | Full-text search, returns JSON |
| `list [--limit N]` | List recent successful captures (default 20) |
| `export <id> --format html\|md\|epub\|pdf [--output path]` | Export a capture; stdout if `--output` omitted |
| `backup <dest.sqlite>` | Consistent backup via `VACUUM INTO` |
| `verify [--all] [--id N]` | SQLite integrity check + SHA-256 content-hash verification |
| `migrate` | Run pending schema migrations |
| `status` | Print capture counts, job queue depth, and database size |

---

## Architecture

### Storage

One SQLite database is the only required persistent artefact. WAL mode is enabled at startup.

| Table | Purpose |
|---|---|
| `captures` | One row per archived page: HTML BLOB, content hash, mode, status, metadata |
| `urls` | Normalised URL identity, latest capture reference |
| `capture_aliases` | Redirect and alternate URLs associated with a capture |
| `metadata` | Extensible key/value metadata per capture |
| `tags` | User-defined tags |
| `capture_tags` | Capture ↔ tag relation |
| `jobs` | Queued, running, succeeded and failed capture jobs |
| `attempts` | Bounded diagnostic history per job |
| `archivebox_imports` | ArchiveBox provenance rows (populated in Phase 3) |
| `captures_fts` | FTS5 virtual table: title, site, author, URL, domain, body text |
| `schema_migrations` | Applied migration versions |

### Capture pipeline

```
POST /api/captures
  → createJob (jobs table, status=queued)
  ← 202 Accepted { jobId }

JobQueue.poll()
  → claimNextJob (atomic UPDATE … RETURNING)
  → Playwright: launch → navigate → dismiss overlays → scroll
  → Readability extraction (article mode) or full-page fallback
  → Asset inliner: fetch external images/fonts → data: URLs
  → HTML sanitiser: allow-list, strip scripts/iframes/forms/handlers
  → Assembler: archive header + responsive CSS + print CSS
  → SHA-256 hash + optional gzip compression
  → INSERT captures (succeeded)
  → finishJob (jobs table, status=succeeded)
```

### Capture modes

| Mode | Description |
|---|---|
| `article` | Readability extracted main content (preferred) |
| `full_page` | Full rendered DOM, sanitised (Readability fallback) |
| `imported_singlefile` | Validated ArchiveBox SingleFile output (Phase 3) |
| `metadata_only` | No usable body; URL and metadata stored only |

### Content Security Policy

Archived pages are served with:

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:
```

This prevents any external network request when viewing a capture.

### Export pipeline

All exports derive from the stored HTML BLOB in SQLite. No separate asset tree is required.

| Format | Implementation |
|---|---|
| HTML | Decompress stored BLOB → stream as `text/html` |
| Markdown + ZIP | Parse stored HTML with linkedom → convert to Markdown → extract data: URL images → ZIP |
| EPUB 3 | Parse stored HTML → extract assets → build EPUB ZIP (pure Bun, no external tools) |
| PDF | Write HTML to temp file → Playwright print CSS → stream PDF → delete temp file |

### Job queue

An in-process poller (`JobQueue`) polls the `jobs` table on a configurable interval (default 2 s). On startup it recovers any jobs left in `running` state by resetting them to `queued`. Job claims are atomic (`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`).

---

## Testing

```bash
bun test                    # all 63 tests
bun test tests/db.test.ts   # schema and database helpers
bun test tests/url.test.ts  # URL normaliser and SSRF guard
bun test tests/sanitize.test.ts   # HTML sanitiser (hostile-input coverage)
bun test tests/phase1.test.ts     # Phase 1 integration: extract → sanitise → assemble → store → search
bun test tests/queue.test.ts      # job lifecycle and tag management
bun test tests/markdown.test.ts   # Markdown + ZIP export
bun test tests/epub.test.ts       # EPUB 3 export (structure and spec compliance)
```

---

## Backup and restore

```bash
# Live backup — consistent snapshot via SQLite VACUUM INTO
bun run src/cli/index.ts backup /path/to/packrat-backup.sqlite

# Verify the live database
bun run src/cli/index.ts verify --all

# Docker: backup the mounted data volume
docker compose exec packrat \
  bun run src/cli/index.ts backup /data/packrat-backup.sqlite

# Restore: replace the database file and restart
cp packrat-backup.sqlite data/packrat.db
docker compose restart packrat
```

The restored instance requires no asset directory, queue daemon or search service.

---

## Licence

Private.
