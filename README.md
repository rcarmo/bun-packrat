# bun-packrat

![Packrat archive index](docs/screenshot.png)

`bun-packrat` captures rendered web pages and source PDFs into SQLite. Web pages use Chromium MHTML as the source of record. Direct PDFs are retained byte-for-byte, deduplicated by SHA-256 and extracted with bounded PDF.js workers.

The service runs on Bun with SQLite FTS5, an in-process job queue and Playwright. It is designed for desktop browsers and Safari on iPhone and iPad.

## Features

- one SQLite database for captures, metadata, search, tags and jobs;
- canonical Chromium MHTML with SHA-256 verification;
- byte-exact source PDFs with inline/range delivery and extracted text;
- offline full-page and simplified Article views;
- a Markdown reader that uses authenticated, same-origin archived images when available;
- server-side full-text search, filters and pagination;
- HTML, Markdown ZIP, EPUB 3 and on-demand PDF exports;
- HTTP API, bookmarklet, Bun CLI and an authenticated queue monitor at `/status`;
- HTTP Basic authentication by default;
- consistent online backup and streaming integrity verification;
- read-only, resumable ArchiveBox migration and verified original-PDF enrichment.

## Start with Docker

Set a password, then build and start the service:

```bash
export PACKRAT_AUTH_PASSWORD='replace-with-a-secret'
make up
```

Open <http://localhost:3047/> and sign in as `packrat`.

For an unauthenticated service on a trusted network, set `PACKRAT_AUTH_DISABLED=1` explicitly.

## Develop locally

```bash
bun install
bun run typecheck
bun test
PACKRAT_AUTH_DISABLED=1 bun run src/server.ts
```

The default database path is `./data/packrat.db`.

## Project status

Fresh web/PDF capture, search, offline reading, export, deletion, backup, verification, queue recovery, ArchiveBox import and original-PDF enrichment are implemented and tested in `v0.2.7`. ArchiveBox hostname cutover and retirement checks remain operational work.

See the [documentation index](docs/README.md) for setup, configuration, architecture, API, CLI and operations. Requirements and delivery status are tracked in the [product requirements](docs/PRD.md) and [implementation plan](docs/PLAN.md).

## Licence

[MIT](LICENSE) © 2026 Rui Carmo
