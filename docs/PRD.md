---
title: Single-File Web Archive PRD
created: 2026-08-10T00:12:35Z
updated: 2026-08-21T08:30:00Z
tags: [archive, bun, playwright, prd, sqlite, web]
status: active
---

# Single-File Web Archive PRD

A Bun service replaces ArchiveBox with a searchable archive whose only persistent application store is SQLite. Web captures store Chromium's complete rendered page and loaded resources as canonical MHTML. Oversized MHTML may use a fixed, bounded image-recompression fallback before storage. Direct PDF responses are preserved byte-for-byte in deduplicated BLOBs and extracted with bounded PDF.js workers.

## Problem

The current ArchiveBox deployment occupies about 35 GB and 130,000 files for roughly 1,500 snapshot directories. Captures can be incomplete, and each URL can produce several extractor outputs that are difficult to browse, back up and convert.

The replacement needs one useful representation of each page, one database to back up, and deterministic exports. It must also import the existing ArchiveBox collection in bulk without discarding provenance or silently treating failed captures as successful ones.

## Goals

1. Capture a URL after browser rendering and store Chromium MHTML as the canonical page snapshot.
2. Open archived pages through ordinary HTTP in desktop and iOS Safari without a browser extension or specialist archive viewer.
3. Keep all persistent application data in one SQLite database, including canonical MHTML and derived metadata.
4. Import and convert the existing ArchiveBox collection at scale, with resumable jobs and an auditable result for every source snapshot.
5. Search titles, URLs, metadata and extracted article text with SQLite FTS5.
6. Export successful web captures as safe self-contained HTML, a Markdown ZIP with local assets, EPUB 3 or a rendered PDF generated on demand.
7. Run the application, workers, command-line interface and migrations on Bun.
8. Make backup and restore a consistent SQLite copy operation.

## Non-goals

- Reproduce every ArchiveBox extractor or preserve interactive application behaviour.
- Use WARC or WACZ as the primary stored representation.
- Run Python, Node.js, PostgreSQL, Redis, Elasticsearch or Sonic services.
- Store rendered page-to-PDF exports, screenshots or duplicate export files permanently. Original source PDFs are retained.
- Circumvent authentication, paywalls, CAPTCHAs or anti-bot controls.
- Guarantee that scripts, video, audio, WebGL or server-side application state remain interactive.
- Replace a forensic web-preservation system that requires byte-identical HTTP response archives.

## Users and main workflows

The initial deployment has one trusted user on the local network.

### Archive a URL

1. The user submits a URL through the web UI, HTTP API, bookmarklet or command line.
2. The service normalises the URL and checks for a recent matching capture.
3. A worker first uses the bounded direct-download path for a PDF-looking URL. For other URLs it opens the page in Chromium through Playwright.
4. The browser pipeline requires the primary document to reach `DOMContentLoaded`, then applies the configurable stricter readiness condition as a bounded best-effort settling signal. It dismisses known overlays, scrolls lazy content into view and records the final URL. An extensionless `application/pdf` response switches to the direct-download path after signature validation.
5. Chromium serialises a web page's rendered DOM and loaded resources as MHTML. Packrat stores snapshots within the configured limit unchanged. For oversized MHTML, it tries colour WebP quality 75 for eligible raster MIME parts, then greyscale WebP quality 75 if required. It stores the first rebuilt MHTML that fits and discards all oversized candidates. A direct PDF is stored byte-for-byte.
6. Packrat hashes the accepted uncompressed canonical bytes, attempts zstd storage compression and uses zstd only when its BLOB is smaller. The capture becomes available at a stable local URL.

### Read on iOS

1. The user opens the archive index in Safari.
2. Search and filters return captures without client-side application requirements.
3. Opening an item serves `text/html; charset=utf-8` from the database.
4. The page uses responsive screen CSS and makes no external network requests by default.

### Export content

The user chooses HTML, Markdown, EPUB or PDF from an archive entry. HTML is rendered from canonical MHTML; Markdown and EPUB use a derived article document; PDF prints the safe full-page HTML. Temporary export files are removed after delivery.

### Read as Markdown

A capture detail page offers distinct `Full page`, `Article` and `Markdown` reading modes.

The Article mode is the primary simplified reading view. It derives semantic article HTML from canonical MHTML, retains captured images as embedded `data:` resources, uses responsive reader typography and makes no external requests.

The Markdown mode converts the captured semantic article content to Markdown and renders it as server-generated HTML. It is a text-oriented derived view, not a new persistent representation. The renderer maps original image URLs back to image bytes in the canonical HTML or MHTML and serves them through authenticated, same-origin `GET|HEAD /captures/:id/images/:index` routes. The route validates the MIME type, adds `nosniff` and leaves canonical bytes unchanged.

The capture pipeline still records the original resolved URL for every derived-article image as SQLite metadata. The browser reader's `.raw` companion uses same-origin archived-image URLs where bytes exist and original HTTP or HTTPS URLs for missing images. The agent-facing `GET /api/captures/:id/content/markdown` response retains original URLs. Both preserve deterministic document order, alt text and optional titles. The Markdown ZIP instead extracts archived data URLs into local assets and uses relative paths.

If the renderer cannot find matching archived bytes, the default Markdown view emits alt text and makes no remote request. The user can enable `?remote=1` for the current view after a privacy warning; only missing archived images then fall back to their original hosts. This can disclose the reader's IP address, browser headers and referrer policy. The generated content contains no capture cookies, authorisation headers, signed request headers or local file paths.

Rendered Markdown and decoded archived image assets are derived on demand. A bounded 32 MiB in-process least-recently-used cache avoids repeated MHTML decoding; no derived files are persistent.

### Delete a capture

1. The user starts deletion from a capture detail or search result.
2. The UI displays the capture title, source URL, capture timestamp and affected relations before confirmation.
3. The user confirms the destructive action. The server rejects unconfirmed deletion requests.
4. The service deletes the capture, its tags, notes, aliases, metadata and search-index entry in one database transaction.
5. If the deleted capture was the URL's latest capture, the service points `latest_capture` to the newest remaining successful capture for that URL, or clears it when none remains.
6. The URL identity remains while other captures or jobs refer to it. The service may remove an unreferenced URL row as part of the same transaction.

### Import ArchiveBox

1. The operator points the importer at an ArchiveBox data root and its `index.sqlite3`.
2. A read-only discovery pass inventories source snapshots, extractor outputs and missing files.
3. The importer records a migration row for every ArchiveBox snapshot before conversion starts.
4. The importer converts snapshots sequentially and commits each outcome independently.
5. Interrupted runs resume without importing successful items twice.
6. A final report accounts for every source row as imported, duplicate, skipped or failed.

## Product requirements

### Canonical capture format

Every successful fresh web capture stores accepted Chromium MHTML as UTF-8 bytes or a compressed SQLite BLOB. MHTML at or below `PACKRAT_MAX_PAGE_BYTES` remains byte-exact. Oversized MHTML may replace embedded JPEG, PNG and WebP MIME parts with smaller WebP encodings through the fixed fallback below. The accepted MHTML is the source of record. Packrat does not retain the oversized original or replace it with Readability output. Direct PDFs use the separate byte-exact source-PDF storage contract.

The canonical BLOB records:

- the complete rendered document body and page chrome after bounded overlay dismissal;
- Chromium's captured stylesheets;
- images, fonts and other loaded resources included by `Page.captureSnapshot`, subject only to the documented oversized-image fallback;
- original and final URL provenance in MIME headers and capture metadata;
- a reproducible hash over the uncompressed MHTML;
- the capture-tool version.

The canonical MHTML is not served as HTML. The raw archive route downloads it as `multipart/related`. The normal capture route derives safe standalone HTML by decoding MIME parts, inlining captured stylesheets, images and fonts, and removing active content. This renderer must remove or disable:

- scripts and event-handler attributes;
- forms and active controls that submit data;
- frames, plug-ins and executable embedded content;
- unresolved remote resource dependencies;
- automatic media playback;
- service workers and refresh redirects.

Derived HTML preserves author CSS when all resource URLs resolve to safe captured `data:` URLs. Links to other pages remain ordinary absolute HTTP or HTTPS links. Opening a derived full-page capture must not cause external requests.

Existing legacy HTML captures remain readable through content sniffing until they are recaptured or imported.

#### Oversized MHTML image fallback

The fallback runs only when the uncompressed Chromium MHTML exceeds `PACKRAT_MAX_PAGE_BYTES`.

1. Re-encode embedded JPEG, PNG and WebP MIME parts as WebP quality 75.
2. Process images sequentially and replace each MIME part only when the encoded bytes are smaller.
3. Rebuild the MHTML and accept it when its uncompressed byte length is within the configured limit.
4. If the colour candidate remains oversized, repeat with greyscale WebP quality 75.
5. Store the first candidate that fits and record whether colour or greyscale recompression was used.
6. If neither candidate fits, fail through the normal capture failure path.

SVG, GIF and non-image MIME parts are unchanged. Packrat discards the oversized original and rejected candidates. It does not store external objects, an article substitute or multiple snapshot variants.

### Page extraction and derived views

Mozilla Readability or an equivalent deterministic DOM extractor supplies title, author, publication metadata, article text for FTS5, Markdown reading mode and article-oriented exports. Extraction never replaces the canonical full-page MHTML.

Fresh web captures record `full_page` mode. Other modes describe legacy, imported or direct-PDF records:

- `article`: legacy Readability-based canonical HTML;
- `full_page`: canonical Chromium MHTML for fresh captures, or legacy sanitised rendered HTML;
- `imported_singlefile`: accepted ArchiveBox SingleFile output after validation and normalisation;
- `metadata_only`: no usable page body was available;
- `pdf`: byte-exact source PDF with bounded extracted text.

The index displays storage mode for exceptional records: source PDF, metadata-only, imported page or legacy article. Ordinary MHTML rows omit the mode label. Capture warnings appear on the index. A failed Readability derivation does not fail valid MHTML; article views then derive from the safe full-page HTML.

### SQLite-only persistence

One SQLite database is the only required persistent application artefact. The service must not depend on an assets directory, queue database, search daemon or permanent export cache.

SQLite stores:

- captures and canonical MHTML or legacy canonical HTML;
- normalised URLs and aliases;
- extracted plain text;
- metadata and headers needed for display and export;
- content hashes;
- capture/import jobs and attempts;
- ArchiveBox provenance and migration outcomes;
- tags and notes;
- FTS5 indexes;
- schema and capture-tool versions.

Runtime browser profiles, downloads and export workspaces may use an operating-system temporary directory. They must be disposable, bounded and excluded from backup.

Use WAL mode during normal operation. Backups must use SQLite's online backup API or `VACUUM INTO`; copying a live database file without a consistent snapshot is unsupported.

### Data model

| Table | Purpose |
|---|---|
| `captures` | One row per archived representation, including canonical MHTML or legacy HTML BLOB, hashes, mode and status |
| `urls` | Normalised URL identity, original spelling, canonical URL and latest capture |
| `capture_aliases` | Redirects and alternate URLs associated with a capture |
| `metadata` | Extensible name/value metadata not promoted to capture columns |
| `tags` | User tags |
| `capture_tags` | Capture-to-tag relation |
| `jobs` | Queued capture job state; the schema also reserves import and export kinds |
| `attempts` | Bounded diagnostic history for each job |
| `archivebox_imports` | Source snapshot ID, timestamp, paths, source hashes and migration outcome |
| `captures_fts` | FTS5 index over title, URL, site, author and extracted text |
| `pdf_blobs` | SHA-256-deduplicated byte-exact source PDF bytes |
| `capture_pdfs` | Capture association and original-response provenance |
| `pdf_extractions` | Bounded PDF.js status, text and warnings |
| `archivebox_pdf_enrichment` | Independent resumable outcome for each ArchiveBox row |
| `capture_storage_migrations` | Durable changed, retained or failed outcome for each capture-body storage migration |
| `schema_migrations` | Applied database migrations |

Capture rows record the compression algorithm and SHA-256 of the uncompressed canonical bytes. Packrat attempts native zstd compression for every accepted web or imported HTML body and stores zstd only when it is smaller than the canonical bytes. Readers permanently support `none`, `gzip` and `zstd` for mixed existing data. `html_size`, page-size checks and `content_hash` always refer to uncompressed canonical bytes. Source PDFs retain their exact bytes in content-addressed BLOB rows.

### Search and browsing

The archive UI provides:

- full-text search;
- URL, domain, title, tag, date and status filters; the API also exposes capture-mode filtering;
- newest, oldest and relevance sorting;
- capture detail and provenance;
- full-page, simplified offline Article and text-oriented Markdown reading modes;
- an explicit control and privacy warning before Markdown mode loads original remote images;
- metadata-only provenance details, capture warnings and failed-capture filtering;
- export actions;
- recapture action;
- deletion with explicit confirmation;
- a direct link to the source URL.

Search results must render server-side or as progressively enhanced HTML so the index remains usable in iOS Safari with minimal JavaScript.

#### Sorting and pagination

The archive index and `GET /api/captures` use the same sorting and pagination rules:

- `newest` is the default for an unsearched article list: `captured_at` descending, then capture ID descending.
- `oldest` sorts by `captured_at` ascending, then capture ID ascending.
- `relevance` is available when a full-text query is present and sorts by FTS5 rank. Capture timestamp descending and capture ID descending provide deterministic tie-breaking.
- The selected sort order remains active when the user changes pages or filters.
- The default page size is 50 captures. The API accepts a `limit` from 1 to 200; the web UI may offer a smaller set of page-size choices within that range.
- Paging is server-side. The initial implementation uses a zero-based `offset`; clients must not need to load the complete result set.
- Previous and next links preserve the full-text query, filters, sort order and page size.
- A page must not repeat or omit captures when several captures have the same timestamp.
- The HTML index displays the current result range and total matching capture count.
- The API response includes `limit`, `offset`, total matching count, and previous/next offsets when those pages exist.
- An offset beyond the final result returns an empty capture list with valid paging metadata, not an error.
- Deleting the final item on a page returns the user to the nearest preceding non-empty page.

### API and command line

Minimum HTTP API:

```text
POST   /api/captures              queue one URL
GET    /api/jobs/:id              inspect progress and errors
DELETE /api/jobs/:id              cancel a queued job
GET    /api/captures              search, filter, sort and page captures
GET    /api/captures/:id          retrieve metadata and available content formats
GET    /captures/:id?meta=1       retrieve the same metadata from the stable capture route
GET    /api/captures/:id/content/:format
                                  extract mhtml|html|article-html|markdown|markdown-zip|epub|pdf
DELETE /api/captures/:id          delete one capture after explicit confirmation
GET    /captures/:id              view archived HTML
GET    /captures/:id/article      view simplified offline article with captured images
GET    /captures/:id/markdown     view server-rendered Markdown
GET    /captures/:id/markdown.raw retrieve the browser reader's raw Markdown source
GET|HEAD /captures/:id/images/:index
                                  retrieve one authenticated archived Markdown image
GET|HEAD /captures/:id/source.pdf retrieve the byte-exact source PDF
GET|HEAD /captures/:id/source.txt retrieve extracted source-PDF text
GET    /captures/:id/export/html  download HTML
GET    /captures/:id/export/md    download Markdown and assets as ZIP
GET    /captures/:id/export/epub  generate and download EPUB
GET    /captures/:id/export/pdf   generate and download rendered PDF
GET    /status                     view the human-readable queue monitor
GET    /api/status                 retrieve machine-readable service status
```

ArchiveBox import and PDF enrichment are CLI-only operations. They have no HTTP mutation route.

Bun CLI commands run as `bun run src/cli/index.ts <command>`:

```text
capture <url> [--force]
import archivebox --data-root <path> [--database <path>]
import archivebox-pdfs --data-root <path>
import status
search <query>
list [--limit N]
export <capture-id> --format html|md|epub|pdf [--output <path>]
delete <capture-id> --confirm
verify [--all] [--id N]
backup <destination.sqlite>
migrate
migrate storage [--dry-run] [--limit N]
status
```

`GET /api/captures` accepts `q`, `url`, `domain`, `title`, `tag`, `dateFrom`, `dateTo`, `status`, `mode`, `sort`, `limit` and `offset`. The response contains capture metadata, `availableFormats`, stable metadata/content URLs, and the paging metadata defined above. This endpoint is the agent-facing search API; it does not require clients to parse the HTML index.

`GET /status` is the authenticated human-readable queue monitor and refreshes every ten seconds. `GET /api/status` retains the compact machine-readable contract for health checks and automation.

`GET /api/captures/:id/content/:format` is the agent-facing extraction API:

| Format | Content type | Semantics |
|---|---|---|
| `mhtml` | `multipart/related` | Canonical Chromium MHTML bytes. Legacy HTML captures return `409 Conflict` because no canonical MHTML exists. |
| `html` | `text/html` | Safe standalone full-page HTML derived from canonical MHTML, or legacy canonical HTML. |
| `article-html` | `text/html` | Simplified semantic article HTML with captured images embedded and no external dependencies. |
| `markdown` | `text/markdown` | Article Markdown with original HTTP or HTTPS image URLs. It can disclose those origins only when a client subsequently loads them. |
| `markdown-zip` | `application/zip` | Offline Markdown and local assets. |
| `epub` | `application/epub+zip` | On-demand EPUB 3 article export. |
| `pdf` | `application/pdf` | On-demand PDF of the safe full-page HTML. |
| `source-pdf` | `application/pdf` | Byte-exact stored source PDF with `HEAD` and single-byte range delivery. |
| `source-pdf-text` | `text/plain` | Bounded PDF.js extraction; empty for verified image-only PDFs. |

Successful extraction responses include `X-Packrat-Capture-Id`, `X-Packrat-Content-Format`, `X-Packrat-Content-Hash`, `X-Packrat-Source-Url` and `X-Packrat-Final-Url`. Responses use `Cache-Control: no-store`. Unknown formats return `404`; missing or unsuccessful captures return `404`; a requested canonical format unavailable for a legacy capture returns `409`.

The API uses the same authentication requirement as the web UI. Agents authenticate with HTTP Basic authentication unless the operator explicitly sets `PACKRAT_AUTH_DISABLED=1`. Search and extraction are read-only and do not require same-origin mutation headers.

Import, capture and delete commands must support JSON output for automation.

### Deletion requirements

- Deletion is available through the web UI, HTTP API and Bun CLI.
- The UI requires a confirmation step and identifies the capture before deletion.
- The HTTP API requires an explicit confirmation value in the request and returns `409 Conflict` when the capture cannot be deleted safely.
- The CLI requires `--confirm`; it must not prompt when JSON output is requested.
- The database deletes the capture and dependent `capture_aliases`, `metadata`, `capture_tags` and FTS5 content atomically.
- Deleting one capture does not delete other captures with the same normalised URL or content hash.
- Jobs keep their diagnostic history. A job that referred to the deleted capture keeps a nullable `capture_id` and records that the capture was deleted.
- A deletion response reports the deleted capture ID, source URL and whether `urls.latest_capture` changed.
- Deletion is permanent. Backup and restore are the recovery mechanism.
- ArchiveBox provenance rows are not deleted through the capture endpoint. Imported captures require the migration tooling to preserve a terminal, auditable source outcome.

## ArchiveBox migration

Mass import was a release requirement and is now implemented as a CLI-only migration utility.

### Source discovery

The importer reads ArchiveBox's `index.sqlite3` in read-only mode and treats it as the source index. It also scans referenced snapshot directories to detect outputs that are present on disk but absent or misreported in the database.

The discovery report must include:

- source database path and schema fingerprint;
- number of URL/snapshot rows;
- snapshot directory count;
- extractor-result counts by type and status;
- total and usable bytes;
- missing, unreadable and orphaned paths;
- exact conversion plan before writes begin.

The importer must tolerate ArchiveBox schema differences by using versioned adapters. An unknown schema stops before conversion and reports the unsupported tables and columns.

### Candidate priority

For each ArchiveBox snapshot, choose the first usable representation in this order:

1. `singlefile.html` that passes structural and asset validation;
2. saved rendered `output.html`, normalised into self-contained HTML;
3. metadata-only record when no usable body exists.

Original-response HTML with asset-tree conversion and WARC replay are not present in the rehearsed source collection and remain unsupported. They require explicit adapters before being added to the candidate order.

ArchiveBox's generated screenshot and `pdf` extractor outputs are not imported. A later enrichment pass accepts only the successful original `wget` response when `headers.json` records `application/pdf`, the file begins `%PDF-`, and recorded length matches when present. Every ArchiveBox provenance row receives an independent terminal enrichment outcome.

### Validation and normalisation

Imported HTML must pass the same safety and portability checks as a fresh capture:

- valid HTML document after parser repair;
- no executable script or event handler;
- no required local file paths;
- no unexpected remote requests when opened in a test browser;
- non-empty visible text or a recorded metadata-only outcome;
- all embedded data URLs parse and stay within configured limits;
- source and capture provenance is present;
- an uncompressed content hash is reproducible.

Existing SingleFile pages should be normalised without fetching the live source. Migration must remain possible when the original website has disappeared.

### Deduplication

The importer preserves ArchiveBox source identity while avoiding duplicate stored bodies.

- An exact content hash may reference an existing canonical body.
- Distinct captures of the same URL remain separate when content or timestamp differs.
- URL normalisation removes fragments and known tracking parameters but never overwrites the original URL.
- Deduplication decisions are stored and reported; no source snapshot disappears silently.

### Resumption and throughput

The importer:

- commits each converted source item in one transaction;
- records a durable outcome for every source snapshot;
- processes candidates sequentially with a 20 MB per-candidate default limit;
- resumes terminal outcomes after process or host failure;
- retries failed rows only when the operator passes `--retry-failed`;
- supports `--dry-run`, `--verify-only` and a bounded `--limit` rehearsal;
- performs no network access or source writes.

The existing archive is about 35 GB with more than 130,000 files. Acceptance testing must use the complete collection, not only fixtures.

### Migration report

The JSON report contains source inventory and schema fingerprint, candidate counts and bytes, outcome counts, processed and resumed counts, up to 100 bounded failure details, target database size, elapsed time and terminal/pending reconciliation totals. The HTML report presents reconciliation totals, outcome counts and failures. `--verify-only` checks source identity, terminal outcomes and capture references against the current ArchiveBox index.

ArchiveBox remains read-only and available until reconciliation passes and a backup of the new database is restored successfully on a clean instance.

## Export requirements

### HTML

The HTML export is a deterministic, safe standalone rendering derived from canonical MHTML. It includes captured author CSS and captured images and fonts as `data:` URLs, removes active content and unresolved remote resources, and opens offline in current Safari, Chromium and Firefox. Legacy canonical HTML exports remain byte-equivalent to their stored uncompressed document.

### Markdown plus assets

The downloadable Markdown ZIP remains an offline export and differs from the Markdown reading mode. The exporter derives an article document from canonical MHTML, extracts embedded data URLs into an `assets/` directory, converts semantic content to Markdown and writes relative asset links. It returns a ZIP containing:

```text
article.md
metadata.json
assets/
```

`metadata.json` contains capture ID, URLs, timestamps, hashes and original extracted metadata.

### EPUB

The EPUB exporter uses the same parsed HTML and extracted assets. It must:

- emit EPUB 3;
- generate valid XHTML;
- include title, author, language, source URL and capture date;
- include a cover when a suitable image exists;
- remove archive controls and unsupported CSS;
- pass `epubcheck` in release tests.

The exporter is a pure Bun ZIP implementation adapted from `rcarmo/bun-readlater-epub`. It requires no external converter. Release tests call `epubcheck` when the command is installed.

### PDF

Rendered page PDFs are generated only when requested. Playwright applies print CSS and streams the result without retaining it. Direct source PDFs are different: Packrat retains their exact bytes, validates `%PDF-`, deduplicates by SHA-256, supports inline/attachment `HEAD` and single-byte `Range` responses, and retains encrypted or image-only documents even when extraction cannot produce text.

PDF.js runs in an isolated worker with defaults of 100 MiB per PDF, 60 seconds, 1,000 pages and 10 MiB of extracted UTF-8 text. Extraction failure never rolls back valid PDF storage. OCR and stored PDF passwords are out of scope.

## Runtime and dependencies

- Runtime: Bun 1.4.x.
- HTTP server and CLI: Bun APIs or a small Bun-compatible framework.
- Database: `bun:sqlite` with FTS5.
- Browser capture: Playwright with persistent browser binaries outside temporary storage.
- DOM parsing and extraction: Bun-compatible libraries, with Mozilla Readability where practical.
- HTML sanitisation: allow-list based and covered by hostile-input tests.
- Tests: Bun test runner.
- Deployment: one service process plus bounded worker execution; no external queue or search service.

`GET /api/status` exposes capture totals, queue depth, active workers, capture duration, import counts and database size. `GET /status` renders the human-readable queue monitor. Logs are structured JSON and exclude page bodies, cookies and authentication headers.

## Security and privacy

- Default deployment is LAN-only and authenticated.
- URL submission rejects unsupported schemes and local-file URLs.
- Server-side request forgery controls block loopback, link-local, private and reserved targets.
- Browser contexts are isolated per capture and discarded afterwards.
- Imported and captured scripts never execute when an archived page is viewed.
- Response headers apply a restrictive Content Security Policy that allows embedded images and styles but denies scripts, frames, forms, workers and network connections.
- Packrat does not inject credentials into browser capture sessions or bypass protected-site controls.
- Exported documents never contain capture-session cookies or authorisation headers.

## Reliability and operations

- Jobs have explicit `queued`, `running`, `succeeded`, `failed` and `cancelled` states.
- Startup recovery marks abandoned pending capture rows as failed, requeues running jobs with attempts remaining and fails exhausted jobs.
- Capture jobs have a three-attempt ceiling.
- DNS, browser operations and PDF extraction use bounded waits.
- A process watchdog exits with status 70 when a capture exceeds the larger of five minutes or four times the configured capture timeout; Bun's `--no-orphans` process mode terminates descendant Chromium processes before service restart invokes normal recovery.
- Duplicate submissions use idempotency keys or normalised URL checks.
- Capture deletion requires explicit confirmation and uses one transaction.
- Database writes use transactions and foreign-key enforcement.
- `PRAGMA integrity_check` and content-hash verification are exposed through the CLI.
- Schema migrations are ordered, transactional where SQLite permits, and covered by upgrade tests.
- Backup documentation includes online backup, restore and integrity verification.
- The service must restore from one SQLite backup without reconstructing an asset tree.

## Performance targets

These original design targets are not automated release gates:

- Search response: p95 under 500 ms for ordinary FTS queries.
- Archive detail response: first byte under 500 ms for a typical stored page on the LAN.
- Fresh capture: complete within 90 seconds for 95% of reachable ordinary article pages.
- Import memory: under 1 GB per worker, with a configurable lower concurrency for small hosts.
- Import resumption: no more than one bounded batch needs reprocessing after forced termination.
- Export: typical Markdown or EPUB output starts within 15 seconds.

Large pages may exceed these targets. The oversized-image fallback processes raster parts sequentially and must fail with explicit configured limits rather than exhausting host memory or disk.

## Acceptance criteria

### Fresh capture

- [x] A submitted URL stores one canonical Chromium MHTML snapshot in SQLite.
- [x] The archived page opens through Safari on iPhone or iPad and desktop Safari, Chromium and Firefox.
- [x] Opening the archived page causes no unapproved network requests.
- [x] The source URL, final URL and capture time are visible.
- [x] Search finds the page by title, domain and body text.
- [x] MHTML within the page limit remains byte-exact before storage compression.
- [x] Oversized MHTML tries colour WebP quality 75, then greyscale WebP quality 75, and replaces only smaller raster parts.
- [x] Only the first rebuilt MHTML that fits is stored; rejected and original oversized bytes are discarded.
- [x] A page that remains oversized after both passes fails without storing a body.

### Storage and recovery

- [x] A clean deployment restores from one SQLite backup.
- [x] No persistent asset, queue, search or export directory is required.
- [x] Integrity and content-hash checks pass after restore.
- [x] Forced termination during capture or import leaves the database consistent.
- [x] New bodies attempt zstd and store it only when its BLOB is smaller than canonical bytes.
- [x] Existing `none`, `gzip` and `zstd` bodies remain readable and verifiable.
- [x] The storage migration verifies each canonical hash, changes a row only when zstd is smaller than its current BLOB, and records a durable per-row outcome.

### ArchiveBox import

- [x] A dry run inventories the complete ArchiveBox source without writing captures.
- [x] Import can be interrupted and resumed.
- [x] Every ArchiveBox source snapshot receives one terminal migration outcome.
- [x] Existing valid `singlefile.html` captures import without live network access.
- [x] Duplicate bodies do not create unreported duplicate storage.
- [x] The final reconciliation report matches the source snapshot count.
- [x] A statistically useful sample from each available source format opens successfully on desktop Chromium; physical iOS Safari remains an operational cutover check.
- [x] The imported database has been backed up, restored and verified on a clean instance.
- [ ] ArchiveBox remains read-only until hostname cutover and rollback validation are complete.

### Markdown reading mode

- [x] Every newly captured derived-article image records its original resolved HTTP or HTTPS URL alongside the canonical snapshot.
- [x] Capture details can switch between archived HTML and server-rendered Markdown.
- [x] The browser `.raw` view uses same-origin archived-image routes where available and contains no embedded data URLs or local file paths.
- [x] API Markdown retains original image URLs for agent consumption.
- [x] Rendered Markdown uses authenticated same-origin archived images when matching bytes exist.
- [x] Only images missing from the archive can use the privacy-gated remote fallback.
- [x] The offline Markdown ZIP continues to contain local relative asset references.
- [x] Missing or invalid original image URLs produce deterministic alt-text output and a capture warning.

### Article list sorting and pagination

- [x] The unsearched archive list defaults to newest first with deterministic ID tie-breaking.
- [x] Full-text results support relevance, newest and oldest sorting.
- [x] Previous and next navigation preserves all active search terms, filters, sort order and page size.
- [x] The HTML index displays the current result range and total matching count.
- [x] The captures API returns `limit`, `offset`, total count and previous/next offsets.
- [x] Equal timestamps, empty result pages and deletion of the last item on a page behave as specified.

### Capture deletion

- [x] A capture can be deleted through the UI, HTTP API and CLI only after explicit confirmation.
- [x] Deletion removes aliases, metadata, tag relations and the FTS5 row in one transaction.
- [x] Deleting the latest capture selects the newest remaining successful capture for that URL.
- [x] Job diagnostics and ArchiveBox provenance remain auditable after capture deletion.
- [x] A restored SQLite backup recovers a deleted capture without an asset tree.

### Exports

- [x] HTML exports derived from canonical MHTML open offline.
- [x] Markdown ZIPs contain local relative asset references only.
- [x] EPUB 3 exports pass `epubcheck`; Apple Books device validation remains an operational release check.
- [x] Rendered PDF generation works on demand and leaves no persistent export.
- [x] Direct source PDFs retain byte-exact content and support bounded extraction and range delivery.

## Delivery phases

### Phase 1 — database and capture proof ✅

- Define the SQLite schema and migrations.
- Capture representative pages with Playwright.
- Produce sanitised self-contained HTML.
- Serve captures to desktop and iOS Safari.
- Verify the no-network viewing policy.

### Phase 2 — archive application ✅

- Add queueing, search, tags, capture history and the web UI.
- Add backup, restore and verification commands.
- Add HTML, Markdown, EPUB and rendered-PDF exports.
- Add direct source-PDF storage, extraction and delivery.
- Add the human-readable `/status` queue monitor and startup recovery.

### Phase 3 — ArchiveBox importer ✅

- Implement schema adapters and source inventory.
- Convert SingleFile and rendered HTML sources, with metadata-only fallback.
- Enrich verified original PDF responses after HTML migration.
- Add resumption, deduplication and reconciliation reports.
- Run a full read-only migration rehearsal against the current archive.

### Phase 4 — EPUB and print ✅

- Add EPUB 3 generation and `epubcheck` tests.
- Add on-demand Playwright PDF generation.
- Validate EPUB structure and run `epubcheck` when installed; Apple Books device validation remains an operational check.

### Phase 5 — bounded oversized capture and advantageous compression ✅

- [x] Add the two-pass `Bun.Image` MHTML fallback.
- [x] Add mixed `none`/`gzip`/`zstd` body decoding and verification.
- [x] Attempt zstd for every accepted body and store it only when smaller.
- [x] Add the resumable, hash-checked, advantageous storage migration.
- [x] Validate resource use and offline rendering on the production profile.
- [ ] Validate migration and rollback during the production deployment.

### Phase 6 — cutover 🔜

- [x] Freeze ArchiveBox writes (VM stopped as of 2026-08-10).
- [x] Run the import, original-PDF enrichment and reconciliation.
- [x] Back up and restore the SQLite database on a clean instance.
- [ ] Redirect the local archive hostname.
- [ ] Validate rollback, then retire ArchiveBox after the agreed read-only period.

## Open decisions

1. HTML storage format — resolved for v0.3.0: attempt zstd for every accepted body, store it only when smaller, and permanently read mixed `none`, `gzip` and `zstd` rows.
2. Whether exact duplicate documents share one body row — resolved for imports: exact canonical hashes reuse an existing capture and retain separate provenance outcomes; ordinary captures retain one body per row.
3. The maximum allowed captured-page size and per-asset size — defaults set (20 MiB / 5 MiB), configurable.
4. The freshness interval before a repeated URL submission creates a new capture — resolved: 24 hours by default, configurable via `PACKRAT_FRESHNESS_SECONDS`, with forced recapture.
5. Whether authenticated captures are required in the first release — resolved for service access: HTTP Basic authentication is required by default. Packrat does not inject credentials into protected-site capture sessions.
6. Whether local archived-link rewriting should be enabled by default — deferred.
7. Whether EPUB generation uses a Bun-native writer or an external converter — resolved: pure Bun ZIP, no external tools.
8. The final service name and local hostname — `packrat` / `packrat.local`; hostname redirect in Phase 6.

## References

- ArchiveBox — current VM (`192.168.1.123`), storage inventory, backup and migration notes.
- [RFC 2397: The `data` URL scheme](https://www.rfc-editor.org/rfc/rfc2397)
- [SQLite online backup API](https://www.sqlite.org/backup.html)
- [SQLite FTS5](https://www.sqlite.org/fts5.html)
- [Mozilla Readability](https://github.com/mozilla/readability)
- [Playwright](https://playwright.dev/)
- [EPUB 3.3](https://www.w3.org/TR/epub-33/)
- [bun-readlater-epub](https://github.com/rcarmo/bun-readlater-epub) — EPUB packaging starting point
