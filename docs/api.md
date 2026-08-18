# HTTP API

The HTTP API uses the same Basic authentication policy as the web UI. Read-only routes accept authenticated cross-origin clients. Browser-originated mutations must be same-origin; command-line clients without browser origin headers are accepted.

## Capture jobs

### Queue a capture

```http
POST /api/captures
Content-Type: application/json
Idempotency-Key: optional-client-key

{"url":"https://example.com/article","force":false}
```

A valid request returns `202 Accepted`:

```json
{"message":"Capture queued","jobId":42,"url":"https://example.com/article"}
```

`force: true` bypasses the freshness reuse interval. An idempotency key can contain at most 200 characters.

### Inspect or cancel a job

```text
GET    /api/jobs/:id
DELETE /api/jobs/:id
```

`GET` returns the job and its attempt diagnostics. `DELETE` cancels only a queued job; other states return `409 Conflict`.

## Search and capture metadata

### List or search captures

```text
GET /api/captures
```

Supported query parameters:

| Parameter | Meaning |
|---|---|
| `q` | FTS5 query over indexed capture text and metadata. |
| `url` | Source URL filter. |
| `domain` | Source domain filter. |
| `title` | Title filter. |
| `tag` | Tag filter. |
| `dateFrom`, `dateTo` | Capture date bounds. |
| `status` | Capture status. |
| `mode` | Capture mode. |
| `sort` | `newest`, `oldest` or `relevance`. |
| `limit` | Page size from 1 to 200; default 50. |
| `offset` | Zero-based result offset. |

The response includes `captures`, `total`, `limit`, `offset`, `previousOffset` and `nextOffset`.

### Read capture metadata

```text
GET /api/captures/:id
```

The response includes metadata, warnings, tags, aliases, available formats, stable content links and deletion impact.

### Update a note

```http
PUT /api/captures/:id/note
Content-Type: application/json

{"note":"Optional note, up to 10000 characters"}
```

### Queue a recapture

```text
POST /api/captures/:id/recapture
```

This always bypasses freshness reuse.

### Delete a capture

```http
DELETE /api/captures/:id
Content-Type: application/json

{"confirm":"123"}
```

The `confirm` value must be the capture ID as a string or the JSON value `true`. Deletion is permanent and removes dependent aliases, metadata, tags and FTS content in one transaction. Job diagnostics remain available.

## Reading routes

| Route | Response |
|---|---|
| `GET /captures/:id` | Safe offline full-page HTML, or the source-PDF viewer for PDF captures. |
| `GET /captures/:id/article` | Simplified offline Article view with captured images. |
| `GET /captures/:id/markdown` | Server-rendered Markdown with remote images disabled by default. |
| `GET /captures/:id/markdown?remote=1` | Markdown view with original remote images enabled. |
| `GET /captures/:id/markdown.raw` | Raw Markdown with original image URLs. |
| `GET /captures/:id?raw=1` | Byte-exact canonical MHTML attachment for fresh captures or byte-exact stored HTML for legacy captures. |
| `GET|HEAD /captures/:id/source.pdf` | Inline byte-exact source PDF with single-byte `Range` support. Add `?download=1` for attachment disposition. |
| `GET|HEAD /captures/:id/source.txt` | Extracted source-PDF text. Encrypted or failed extraction returns `409`. |

Capture rows show the source domain, capture date, canonical body size and author or site when available. Storage mode appears only for exceptional records such as metadata-only, imported or legacy article captures. Asset counts are not computed while rendering the list.

The web filter form omits capture mode because it is an internal representation detail. The `mode` query parameter remains available through `GET /api/captures` for automation and diagnostics.

The capture list and rendered Full page, Article and Markdown toolbars link to the stored original source URL. The link opens in a new tab. Following it leaves Packrat and contacts the source site.

The full-page and Article routes use a restrictive Content Security Policy and do not load remote resources until the user follows an external link.

## Content extraction

```text
GET /api/captures/:id/content/:format
```

| Format | Content type | Result |
|---|---|---|
| `mhtml` | `multipart/related` | Canonical Chromium MHTML. Legacy HTML records return `409 Conflict`. |
| `html` | `text/html` | Safe standalone full-page HTML. |
| `article-html` | `text/html` | Simplified offline article HTML. |
| `markdown` | `text/markdown` | Article Markdown with original HTTP or HTTPS image URLs. |
| `markdown-zip` | `application/zip` | Offline Markdown, metadata and local assets. |
| `epub` | `application/epub+zip` | On-demand EPUB 3. |
| `pdf` | `application/pdf` | On-demand PDF of safe full-page HTML. |
| `source-pdf` | `application/pdf` | Stored byte-exact source PDF; supports `HEAD` and one byte range. |
| `source-pdf-text` | `text/plain` | Bounded PDF.js text extraction. |

Successful responses include:

```text
X-Packrat-Capture-Id
X-Packrat-Content-Format
X-Packrat-Content-Hash
X-Packrat-Source-Url
X-Packrat-Final-Url
```

Responses use `Cache-Control: no-store`. The route pattern rejects unknown formats with `404`. Missing or unsuccessful captures also return `404`.

## Download routes

```text
GET /captures/:id/export/html
GET /captures/:id/export/md
GET /captures/:id/export/epub
GET /captures/:id/export/pdf
```

Each route streams an attachment. Packrat does not retain generated export files.

## Tags

```text
GET    /api/tags
GET    /api/captures/:id/tags
POST   /api/captures/:id/tags
DELETE /api/captures/:id/tags
```

Add or remove one capture-tag association by sending the same JSON body with `POST` or `DELETE`:

```json
{"tag":"reference"}
```

Removing a tag's final capture association also removes the unused tag from the global tag index. The web index exposes this through **Manage tags…** in each capture's **More** menu.

## Service status and bookmarklet

```text
GET /status
GET /api/status
GET /bookmarklet.js
```

`/status` is the human-readable queue monitor. It refreshes every ten seconds and shows queue totals, active workers, target URLs, attempts, timings, capture links and readable errors for active and recent jobs.

`/api/status` is the machine-readable status response. It reports capture counts, queue depth, active workers, capture duration, import counts and database size.

## Markdown reading images

The HTML Markdown reader at `GET /captures/:id/markdown` uses images already stored inside the canonical HTML or MHTML capture without contacting the original host. Stored images are exposed through authenticated, same-origin URLs:

```text
GET  /captures/:id/images/:index
HEAD /captures/:id/images/:index
```

The route returns only validated image MIME types with `nosniff`; it does not change the canonical capture bytes. Images absent from the archive remain blocked unless the reader explicitly enables remote images for that view.

## ArchiveBox source-PDF enrichment

After the HTML migration, enrich only verified original PDF responses:

```bash
bun run src/cli/index.ts import archivebox-pdfs --data-root /srv/archivebox/data
bun run src/cli/index.ts import archivebox-pdfs --data-root /srv/archivebox/data --verify-only
```

The classifier requires one successful `wget` output, one successful `headers` output reporting `application/pdf`, a `%PDF-` signature and a matching recorded `Content-Length` when present. ArchiveBox's generated `pdf` extractor output is ignored. Every provenance row receives an independent, resumable enrichment outcome.

Save the bookmarklet payload as:

```text
javascript:(()=>{/* contents of /bookmarklet.js */})()
```
