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
| `GET /captures/:id` | Safe offline full-page HTML. |
| `GET /captures/:id/article` | Simplified offline Article view with captured images. |
| `GET /captures/:id/markdown` | Server-rendered Markdown with remote images disabled by default. |
| `GET /captures/:id/markdown?remote=1` | Markdown view with original remote images enabled. |
| `GET /captures/:id/markdown.raw` | Raw Markdown with original image URLs. |
| `GET /captures/:id?raw=1` | Canonical MHTML attachment for fresh captures; stored HTML for legacy captures. |

The full-page and Article routes use a restrictive Content Security Policy and do not load remote resources.

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
GET  /api/tags
GET  /api/captures/:id/tags
POST /api/captures/:id/tags
```

Add a tag with:

```json
{"tag":"reference"}
```

## Service status and bookmarklet

```text
GET /api/status
GET /bookmarklet.js
```

The status response reports capture counts, queue depth, active workers, capture duration, import counts and database size.

Save the bookmarklet payload as:

```text
javascript:(()=>{/* contents of /bookmarklet.js */})()
```
