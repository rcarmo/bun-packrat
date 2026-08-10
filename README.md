# bun-packrat

A single-file web archive service. Each capture is a self-contained, sanitised HTML document stored in SQLite and served directly to desktop and iOS Safari. Markdown, EPUB and PDF are derived on demand.

Replaces a 35 GB / 130,000-file [ArchiveBox](https://archivebox.io/) deployment with one SQLite database.

## Project status

**Phase 1 — database and capture proof** (in progress)

- [x] SQLite schema + FTS5 migrations
- [x] URL normalisation and SSRF guard
- [x] HTML sanitiser (allow-list, hostile-input tested)
- [x] Asset inliner (data: URLs)
- [x] Mozilla Readability article extraction
- [x] Self-contained HTML assembler with archive header
- [x] Playwright capture pipeline
- [x] HTTP server (serve + submit)
- [x] CLI (capture, search, list, backup, status)
- [x] 41-test suite, all passing

See [docs/PRD.md](docs/PRD.md) for full requirements and delivery phases.  
See [PLAN.md](PLAN.md) for the implementation plan.

## Quick start

### Docker (recommended)

```bash
# Build and start
make up

# Or manually:
docker compose build
mkdir -p data config
docker compose up -d

# Open the archive index
open http://localhost:3047/
```

Volumes:

| Mount | Purpose |
|---|---|
| `./data` | SQLite database (`packrat.db`) — back this up |
| `./config` | Optional `config/.env` to override environment variables |

Optional `config/.env` example:

```dotenv
PACKRAT_BASE_URL=http://packrat.local
PACKRAT_HTML_COMPRESSION=gzip
PACKRAT_MAX_CONCURRENT_CAPTURES=3
# PUID=1000
# PGID=1000
```

Chromium is baked into the image — no browser download at startup. The image is ~500 MB.

### Local (Bun)

```bash
# Install dependencies (Bun required)
bun install

# Run migrations and start the server
PACKRAT_DB=./data/packrat.db bun run src/server.ts

# Archive a URL from the CLI
bun run src/cli/index.ts capture https://example.com/article

# Open the archive index
open http://localhost:3047/
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PACKRAT_DB` | `./data/packrat.db` | SQLite database path |
| `PORT` | `3047` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server bind address |
| `PLAYWRIGHT_BROWSERS_PATH` | `/workspace/bin/pw-browsers` | Playwright browser directory |
| `PACKRAT_CAPTURE_TIMEOUT_MS` | `60000` | Max capture time (ms) |
| `PACKRAT_MAX_PAGE_BYTES` | `20971520` | Max stored page size (20 MB) |
| `PACKRAT_MAX_ASSET_BYTES` | `5242880` | Max asset size to inline (5 MB) |
| `PACKRAT_HTML_COMPRESSION` | `none` | `none` or `gzip` |
| `PACKRAT_BASE_URL` | `http://localhost:3047` | Service base URL |

## HTTP API

```
POST   /api/captures         { "url": "https://..." }  → 202 Accepted
GET    /api/captures         ?q=query&limit=50         → JSON list
GET    /api/captures/:id                               → JSON metadata
GET    /captures/:id                                   → Archived HTML
GET    /api/status                                     → Health + counts
```

## CLI

```
bun run src/cli/index.ts capture <url>
bun run src/cli/index.ts search  <query>
bun run src/cli/index.ts list    [--limit N]
bun run src/cli/index.ts backup  <dest.sqlite>
bun run src/cli/index.ts status
```

## Tests

```bash
bun test
```

## Architecture

One SQLite database is the only required persistent artefact.

```
captures      — HTML blob, hashes, metadata, mode, status
urls          — normalised URL identity, latest capture
capture_fts   — FTS5 index (title, domain, author, body text)
jobs          — capture/import job state
archivebox_imports — migration provenance (Phase 3)
```

Captures are served with a restrictive Content Security Policy (`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:`) that prevents any external network requests when viewing archived pages.

## EPUB

Phase 4 EPUB export will start from [`rcarmo/bun-readlater-epub`](https://github.com/rcarmo/bun-readlater-epub) to reuse proven Bun EPUB packaging and compatibility work.

## Licence

Private.
