# Operations

The SQLite database is Packrat's only required persistent application artefact. Back up the database with the CLI while the service is running; do not copy a live WAL database directly.

## Backup

Create a consistent snapshot with `VACUUM INTO`:

```bash
bun run src/cli/index.ts backup /path/to/packrat-backup.sqlite
```

For Docker:

```bash
docker compose exec packrat \
  bun run src/cli/index.ts backup /data/packrat-backup.sqlite
```

Verify the backup as a separate database:

```bash
PACKRAT_DB=/path/to/packrat-backup.sqlite \
  bun run src/cli/index.ts verify --all
```

## Restore

Stop the service before replacing the live database:

```bash
docker compose stop packrat
rm -f data/packrat.db-wal data/packrat.db-shm
cp /path/to/packrat-backup.sqlite data/packrat.db
docker compose start packrat
```

Then verify the restored service database:

```bash
PACKRAT_DB=./data/packrat.db bun run src/cli/index.ts verify --all
```

No asset directory, queue database or search index rebuild is required.

## Integrity checks

```bash
bun run src/cli/index.ts verify --all
```

Verification runs SQLite's integrity check and recomputes SHA-256 hashes from uncompressed stored bodies. Bodies are loaded and hashed one at a time, so verification remains bounded for archive-scale databases. A non-zero exit status indicates a failed database or hash check.

## ArchiveBox migration rehearsal

Keep ArchiveBox stopped or otherwise quiescent, and mount its data root read-only. A container rehearsal can use:

```bash
docker run --rm --network none \
  -e PACKRAT_DB=/data/packrat.sqlite \
  -e PACKRAT_AUTH_DISABLED=1 \
  -e PACKRAT_HTML_COMPRESSION=gzip \
  -v /srv/archivebox/data:/archivebox:ro \
  -v /srv/packrat-migration-test:/data \
  ghcr.io/rcarmo/bun-packrat:latest \
  bun run src/cli/index.ts import archivebox \
    --data-root /archivebox \
    --report-json /data/archivebox-import.json \
    --report-html /data/archivebox-import.html
```

Use `--dry-run` first. The importer defaults to 20 MB per HTML candidate to keep memory bounded on small hosts. An oversized or malformed SingleFile page falls back to rendered HTML; if no candidate passes validation, the source becomes an auditable metadata-only capture rather than disappearing.

After reconciliation:

1. run `verify --all` against the imported database;
2. run `import archivebox-pdfs --data-root /archivebox` to enrich verified original PDF responses;
3. create a consistent backup with `backup`;
4. restore that backup under a separate filename;
5. run `verify --all` against the restored copy;
6. test representative SingleFile, rendered-HTML, metadata-only and source-PDF records;
7. keep ArchiveBox read-only until hostname cutover and rollback validation are complete.

## Queue recovery

The queue records jobs and attempts in SQLite. On startup, Packrat first marks abandoned `pending` capture rows as failed with `Capture interrupted by process restart`. It then requeues abandoned `running` jobs that have attempts remaining. Exhausted jobs become `failed`; capture jobs have a three-attempt ceiling.

DNS resolution, browser operations and PDF extraction have explicit time bounds. A capture watchdog exits the process with status 70 when a capture remains unresolved for the larger of five minutes or four times `PACKRAT_CAPTURE_TIMEOUT_MS`. The service manager restarts Packrat, and startup recovery applies the rules above. This prevents a lost Chromium protocol promise from occupying a worker indefinitely.

Inspect a job through the API:

```bash
curl -u 'packrat:password' http://localhost:3047/api/jobs/42
```

A queued job can be cancelled with `DELETE /api/jobs/:id`. Running work is allowed to finish or is recovered after process restart.

## Status and logs

Open the authenticated human-facing monitor at:

```text
http://localhost:3047/status
```

It refreshes every ten seconds and lists queue totals, workers, active and recent capture jobs, target URLs, attempts, timings, result links and readable errors. `GET /api/status` remains the stable machine-readable endpoint:

```bash
curl -u 'packrat:password' http://localhost:3047/api/status
docker compose logs -f packrat
```

Logs are structured JSON. Capture bodies, cookies and authorisation headers are not logged.

The API status response reports:

- capture totals by status;
- queued and running jobs;
- active worker count;
- average and p95 capture duration;
- import count;
- database size.

## Security controls

- Basic authentication is required unless `PACKRAT_AUTH_DISABLED=1`.
- Browser-originated mutations must be same-origin; non-browser API clients can omit browser origin headers.
- Submitted URLs accept only HTTP and HTTPS and cannot contain embedded credentials.
- DNS and literal-address checks reject loopback, link-local, private and reserved targets for each browser origin.
- Every capture uses an isolated browser context that is discarded after completion.
- Offline views remove scripts, forms, frames and unresolved resources.
- Content Security Policy denies network access and active content in full-page and Article views.

Packrat does not bypass authentication, paywalls, CAPTCHAs or anti-bot controls.

## Capacity limits

The default maximum canonical page size is 20 MB. Legacy asset inlining limits each asset to 5 MB. Direct source PDFs are limited to 100 MB; PDF.js extraction is limited to 60 seconds, 1,000 pages and 10 MB of UTF-8 text. Change these values through the corresponding `PACKRAT_*` environment variables after checking available memory and database growth.

The rendered Markdown reader caches at most 32 MiB of decoded archived image assets in process memory. The cache is not persistent and does not change canonical bytes.

Rendered PDF and EPUB exports are generated on demand and are not retained after delivery. Direct source PDFs are persistent, byte-exact archive content.
