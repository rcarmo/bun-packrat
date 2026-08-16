# Configuration

Packrat reads configuration from environment variables when the process starts. Docker deployments can put the same variables in `config/.env`.

| Variable | Default | Meaning |
|---|---:|---|
| `PACKRAT_DB` | `./data/packrat.db` | SQLite database path. Docker sets `/data/packrat.db`. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `PORT` | `3047` | HTTP port, from 1 to 65535. |
| `PACKRAT_BASE_URL` | `http://localhost:3047` | Public service URL used in CLI output and the bookmarklet. |
| `PLAYWRIGHT_BROWSERS_PATH` | `/workspace/bin/pw-browsers` | Playwright browser directory. Docker sets `/browsers`. |
| `PACKRAT_CAPTURE_TIMEOUT_MS` | `60000` | Browser navigation and operation timeout in milliseconds. |
| `PACKRAT_MAX_CONCURRENT_CAPTURES` | `2` | Parallel capture workers, from 1 to 16. |
| `PACKRAT_MAX_PAGE_BYTES` | `20971520` | Maximum canonical page size: 20 MB. |
| `PACKRAT_MAX_ASSET_BYTES` | `5242880` | Maximum asset size for the legacy HTML inliner: 5 MB. |
| `PACKRAT_HTML_COMPRESSION` | `none` | Stored body compression: `none` or `gzip`. |
| `PACKRAT_FRESHNESS_SECONDS` | `86400` | Reuse interval for a successful capture. `0` disables reuse. |
| `PACKRAT_CAPTURE_WAIT_UNTIL` | `networkidle` | Best-effort readiness state: `load`, `domcontentloaded`, `networkidle` or `commit`. |
| `PACKRAT_CAPTURE_SETTLING_MS` | `1000` | Delay after readiness and before scrolling, from 0 to 60000 ms. |
| `PACKRAT_AUTH_USER` | `packrat` | HTTP Basic authentication username. |
| `PACKRAT_AUTH_PASSWORD` | unset | Required password unless authentication is disabled. |
| `PACKRAT_AUTH_DISABLED` | `0` | Set to `1` to disable authentication deliberately. |
| `PUID` | process default | Docker entry-point user ID. Set it in the Compose environment. |
| `PGID` | process default | Docker entry-point group ID. Set it in the Compose environment. |

## Capture readiness

The primary document must reach `DOMContentLoaded`. A configured `load` or `networkidle` wait is then bounded to 10 seconds. Timeout produces a capture warning and processing continues from the parsed document.

`PACKRAT_CAPTURE_TIMEOUT_MS` still applies to the required navigation and browser operations.

## Authentication

Startup requires `PACKRAT_AUTH_PASSWORD` unless `PACKRAT_AUTH_DISABLED=1`. All UI and API routes use the same authentication policy.

Browser-originated mutations must be same-origin. Requests from command-line clients without `Origin` and `Sec-Fetch-Site` headers are accepted.

## Compression

`PACKRAT_HTML_COMPRESSION=gzip` compresses stored bodies. The `content_hash` remains the SHA-256 hash of the uncompressed canonical bytes.
