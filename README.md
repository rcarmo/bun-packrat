# bun-packrat

A single-file web archive service. Fresh captures store Chromium MHTML as the canonical snapshot in SQLite; safe standalone HTML, Markdown, EPUB and PDF are derived on demand for desktop and iOS Safari.

Replaces a 35 GB / 130,000-file ArchiveBox deployment with one SQLite database and one service process.

## Status

All currently actionable non-ArchiveBox requirements are implemented. Phase 3 migration and Phase 5 cutover remain deferred. 117 tests pass across 13 files, including real `epubcheck` validation when installed.

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
PACKRAT_AUTH_USER=packrat
PACKRAT_AUTH_PASSWORD=replace-with-a-secret
PUID=1000
PGID=1000
```

The image is ~500 MB (Chromium headless-shell included). No browser download occurs at container start. Authentication is required by default: set `PACKRAT_AUTH_PASSWORD` in the shell or `config/.env`. For an intentionally unauthenticated trusted-LAN deployment, set `PACKRAT_AUTH_DISABLED=1` explicitly.

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
| `PACKRAT_MAX_ASSET_BYTES` | `5242880` | Maximum asset size for the legacy HTML inliner (5 MB) |
| `PACKRAT_HTML_COMPRESSION` | `none` | Stored HTML compression: `none` or `gzip` |
| `PACKRAT_FRESHNESS_SECONDS` | `86400` | Reuse the latest successful capture for this interval; `0` disables |
| `PACKRAT_CAPTURE_WAIT_UNTIL` | `networkidle` | Playwright readiness: `load`, `domcontentloaded`, `networkidle`, `commit` |
| `PACKRAT_CAPTURE_SETTLING_MS` | `1000` | Delay after readiness before overlay removal and scrolling |
| `PACKRAT_AUTH_USER` | `packrat` | HTTP Basic authentication username |
| `PACKRAT_AUTH_PASSWORD` | none | Required password unless authentication is explicitly disabled |
| `PACKRAT_AUTH_DISABLED` | `0` | Set to `1` only for an intentionally unauthenticated trusted LAN |

---

## HTTP API

### Captures

```
POST   /api/captures
       Body: { "url": "https://...", "force": false }
       Optional header: Idempotency-Key
       Response: 202 { "message": "Capture queued", "jobId": N, "url": "..." }

GET    /api/captures
       Query: q, limit, offset, url, domain, title, tag, dateFrom, dateTo,
              status, mode, sort=newest|oldest|relevance
       Response: { "captures": [...], "total": N, "limit": N, "offset": N,
                   "previousOffset": N|null, "nextOffset": N|null }

GET    /api/captures/:id
       Response: capture metadata, availableFormats, stable content links, warnings,
                 note, aliases, provenance and deletion impact
DELETE /api/captures/:id
       Body: { "confirm": "<capture-id>" }; permanently deletes the capture

GET    /captures/:id/article
       Simplified offline article with captured images embedded; no remote requests
GET    /captures/:id/markdown
       Text-oriented rendered Markdown; original remote images disabled until enabled
GET    /captures/:id/markdown.raw
       Raw Markdown referencing original image URLs

GET    /api/captures/:id/content/:format
       Extract mhtml, html, article-html, markdown, markdown-zip, epub or pdf with provenance headers

GET    /bookmarklet.js
       Bookmarklet payload; save as javascript:(()=>{...contents...})()

POST   /api/captures/:id/recapture
       Queue a forced recapture, bypassing the freshness window

PUT    /api/captures/:id/note
       Body: { "note": "..." }

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
       Response: job row plus attempt diagnostics
DELETE /api/jobs/:id
       Cancel a queued job

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
| `capture <url> [--force]` | Archive a URL; reuse a fresh capture unless forced (JSON output) |
| `search <query> [--domain/--tag/--mode/--status/--sort]` | Filtered full-text search, returns JSON |
| `delete <id> --confirm` | Permanently delete one capture and dependent data; returns JSON |
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
| `captures` | One row per archived page: canonical MHTML or legacy HTML BLOB, content hash, mode, status, metadata |
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
  → Playwright: launch → DNS/IP guard every request → navigate → scroll
  → Scroll lazy content and remove bounded overlay chrome
  → Chromium CDP Page.captureSnapshot(format=mhtml)
  → Readability derives metadata and FTS text only
  → SHA-256 hash over canonical MHTML + optional gzip compression
  → INSERT captures (succeeded)

View/export pipeline
  → Sniff legacy HTML or canonical MHTML
  → Decode MHTML MIME parts and inline captured CSS/images/fonts
  → Strip scripts, forms, frames, active attributes and unresolved resources
  → Serve safe full-page HTML; derive article Markdown/EPUB on demand
  → finishJob (jobs table, status=succeeded)
```

### Capture modes

| Mode | Description |
|---|---|
| `article` | Legacy Readability-based canonical HTML |
| `full_page` | Canonical Chromium MHTML for fresh captures; legacy sanitised rendered HTML remains supported |
| `imported_singlefile` | Validated ArchiveBox SingleFile output (Phase 3) |
| `metadata_only` | No usable body; URL and metadata stored only |

### Content Security Policy

Archived pages are served with:

```
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

This prevents any external network request when viewing a capture.

### Export pipeline

All exports derive from the canonical MHTML or legacy HTML BLOB in SQLite. No separate asset tree is required.

| Format | Implementation |
|---|---|
| HTML | Decode canonical MHTML → safe standalone full-page HTML with captured CSS/images/fonts |
| Canonical MHTML | Raw `multipart/related` download from the capture's `?raw=1` route |
| Article view | Derive simplified article HTML with captured images embedded; fully offline |
| Markdown view | Text-oriented derivation using stored image provenance; remote images gated per view |
| Markdown + ZIP | Derive article HTML → convert to Markdown → extract data: URL images → offline ZIP |
| EPUB 3 | Derive article HTML → extract assets → build EPUB ZIP (pure Bun, no external tools) |
| PDF | Render safe full-page HTML in Playwright → stream PDF → delete temp file |

### Job queue

An in-process poller (`JobQueue`) polls the `jobs` table on a configurable interval (default 2 s). On startup it requeues abandoned jobs with attempts remaining and fails exhausted jobs. Each claim/finish is recorded in `attempts`. Job claims are atomic (`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`).

---

## Testing

```bash
bun test                    # all 117 tests (epubcheck test skips if unavailable)
bun test tests/api.test.ts  # agent search/content HTTP API
bun test tests/canonical.test.ts # MHTML decoding and safe rendering
bun test tests/db.test.ts   # schema and database helpers
bun test tests/url.test.ts  # URL normaliser and SSRF guard
bun test tests/sanitize.test.ts   # HTML sanitiser (hostile-input coverage)
bun test tests/phase1.test.ts     # Phase 1 integration: extract → sanitise → assemble → store → search
bun test tests/queue.test.ts      # job lifecycle and tag management
bun test tests/markdown.test.ts   # Markdown + ZIP export
bun test tests/epub.test.ts       # EPUB 3 export (structure and epubcheck compliance)
bun test tests/assets.test.ts     # absolute links + tracker removal
bun test tests/upgrade.test.ts    # migration upgrade + standalone backup restore
bun test tests/overlays.test.ts   # overlay removal must preserve newsletter articles
bun test tests/features.test.ts   # deletion, paging order, Markdown image provenance
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

# Restore while the service is stopped (never replace a live WAL database)
docker compose stop packrat
rm -f data/packrat.db-wal data/packrat.db-shm
cp packrat-backup.sqlite data/packrat.db
docker compose start packrat
bun run src/cli/index.ts verify --all
```

The restored instance requires no asset directory, queue daemon or search service.

---

## Licence

Private.
