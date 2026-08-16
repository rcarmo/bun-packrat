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

Verification runs SQLite's integrity check and recomputes SHA-256 hashes from uncompressed stored bodies. A non-zero exit status indicates a failed database or hash check.

## Queue recovery

The queue records jobs and attempts in SQLite. On startup, Packrat requeues abandoned `running` jobs that have attempts remaining. Exhausted jobs become `failed`.

Inspect a job through the API:

```bash
curl -u 'packrat:password' http://localhost:3047/api/jobs/42
```

A queued job can be cancelled with `DELETE /api/jobs/:id`. Running work is allowed to finish or is recovered after process restart.

## Status and logs

```bash
curl -u 'packrat:password' http://localhost:3047/api/status
docker compose logs -f packrat
```

Logs are structured JSON. Capture bodies, cookies and authorisation headers are not logged.

The status endpoint reports:

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

The default maximum canonical page size is 20 MB. Legacy asset inlining limits each asset to 5 MB. Change these values through `PACKRAT_MAX_PAGE_BYTES` and `PACKRAT_MAX_ASSET_BYTES` after checking available memory and database growth.

PDF and EPUB files are generated on demand and are not retained after delivery.
