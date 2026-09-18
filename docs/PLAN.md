# v0.3.1 implementation and release plan

Packrat v0.3.1 uses Bun 1.4 to remove the unfiltered homepage's cold and idle latency. It retains the bounded MHTML and storage-compression work released in v0.3.0.

Requirements: [PRD.md](PRD.md)

## v0.3.0 storage and capture scope

### Oversized MHTML fallback

1. Capture Chromium MHTML normally.
2. Keep snapshots at or below `PACKRAT_MAX_PAGE_BYTES` byte-exact before storage compression.
3. For an oversized snapshot, re-encode embedded JPEG, PNG and WebP MIME parts as WebP at quality 75. Process parts sequentially and replace a part only when the result is smaller.
4. Rebuild the MHTML. Accept it if its uncompressed size is at or below the configured limit.
5. If it is still oversized, apply greyscale WebP at quality 75 to eligible parts, again replacing only smaller results.
6. Store the first rebuilt MHTML that fits. Discard the oversized original and all rejected candidates.
7. Fail the capture through the existing failure path when neither candidate fits.

SVG, GIF, fonts and other MIME parts are unchanged. A successful fallback records a capture warning that identifies the colour or greyscale pass. Packrat does not retain an external original, article substitute or additional snapshot.

### Capture-body compression

- Attempt `Bun.zstdCompress()` for every accepted web capture or imported HTML body.
- Store zstd only when its BLOB is smaller than the canonical bytes; otherwise store the canonical bytes with `compression='none'`.
- Preserve `html_size` and `content_hash` as the size and SHA-256 of uncompressed canonical bytes.
- Permanently support `none`, `gzip` and `zstd` in readers, exports and verification.
- Keep source-PDF storage byte-exact and outside this compression policy.

### Existing-body migration

The idempotent `migrate storage` command:

1. requires a consistent backup before production use;
2. reads capture bodies sequentially;
3. decompresses each row according to its current marker;
4. verifies the existing canonical SHA-256 before any write;
5. creates a zstd candidate;
6. updates one row in one short transaction only when zstd is smaller than the current stored BLOB;
7. retains `gzip` or `none` when either is smaller than or equal to zstd;
8. persists one changed, retained or failed outcome per row so bounded reruns advance safely;
9. reports scanned, resumed, pending, changed, retained, failed, input and output byte totals;
10. supports dry-run and bounded rehearsal options;
11. finishes with SQLite integrity and full content-hash verification.

The migration does not run `VACUUM` automatically. The operator decides whether reclaimed free pages justify a separate maintenance window.

## v0.3.1 homepage latency scope

The production unfiltered homepage took 9.989 seconds on the first request after idle and about 170 ms when warm. `/api/status`, `/api/captures?limit=50` and `/bookmarklet.js` did not show the same delay, which isolated the server-rendered index path.

The fix has four parts:

1. Load tags and deletion-impact summaries in bounded batches for all visible capture IDs.
2. Keep one rendered response for the unfiltered `GET /` page in process memory. It has no expiry.
3. Invalidate on local archive mutations and detect commits from other SQLite connections with `PRAGMA data_version`.
4. Warm the default page after startup and after every capture job settles, without holding the worker slot or delaying queue turnover.

Search, filter, pagination and bookmarklet-prefilled pages always render live. A render enters the cache only when the local generation and SQLite data version remain unchanged from start to finish. Callers waiting for an invalidated render retry. Responses retain `Cache-Control: no-store`.

## Implementation sequence

| # | Work | Main files | Evidence |
|---:|---|---|---|
| 1 | Add MHTML MIME-part rewriting and body codecs | `src/capture/`, `tests/canonical.test.ts`, `tests/phase1.test.ts` | Fixed colour/greyscale passes, mixed-codec tests and bounded failure path |
| 2 | Add automatic advantageous zstd and storage migration | capture pipeline, importer, `src/cli/`, migration tests | Hash-preserving per-row decisions and idempotent reruns |
| 3 | Add capture safeguards and source-PDF support | queue, container command, PDF modules | Bounded workers, `--no-orphans`, byte-exact PDF checks |
| 4 | Reproduce the production homepage delay | VM 119 and production SQLite data | 9.989-second first request; API and static routes remain fast |
| 5 | Batch index metadata queries | `src/db/index.ts`, `src/server.ts` | One tag query and grouped deletion-impact queries per visible page |
| 6 | Add the default homepage response cache | `src/server.ts` | Single-flight rendering, no time-to-live and live query-bearing pages |
| 7 | Add mutation and settlement invalidation | `src/server.ts`, `src/queue/index.ts` | Generation and `data_version` checks; asynchronous post-job warming |
| 8 | Run the Bun 1.4 release gate and race review | complete test suite and independent review | 180 tests, 19 files, 773 expectations and no blocker |
| 9 | Release and deploy v0.3.1 | GitHub release, GHCR, Portainer stack 114 | Immutable digest, health, restart latency and current post-capture page |

## Test requirements

### Capture and storage

- normal MHTML below the limit remains byte-exact;
- colour WebP quality 75 runs before greyscale WebP quality 75;
- no image part is replaced by a larger encoding;
- SVG, GIF and non-image MIME parts remain unchanged;
- fallback failure stores no oversized body;
- `none`, `gzip` and `zstd` bodies produce identical canonical bytes;
- new bodies use zstd only when it is smaller;
- migration verifies hashes, retains advantageous existing codecs and resumes safely.

### Homepage cache

- default `/` requests share one resident render;
- any query parameter bypasses the resident entry;
- local mutations invalidate both completed and in-flight renders;
- external commits before or during rendering prevent stale publication;
- capture success and failure call the settlement hook;
- the settlement hook runs after terminal job state and outside the queue's critical path;
- every index response uses `Cache-Control: no-store`.

### Production acceptance

- deploy the immutable manifest digest to Portainer endpoint 19, stack 114;
- confirm the container reports healthy and carries the v0.3.1 OCI revision;
- stop and start the container, retrying only connection refusals before the first accepted `/` request;
- verify filtered, search and `?archive=` pages render live;
- submit a capture, wait for settlement and verify the next homepage is fast and contains it;
- delete the test capture and verify the following homepage no longer contains it;
- inspect logs for `index.cache_warm_failed` and `queue.capture_settled_hook_failed`.

## Operator-recorded release and deployment evidence

The operational record for this deployment is `/workspace/notes/operations/packrat-v0.3.1-release-2026-09-18.md`. The repository does not contain the production database or Portainer logs.

- PR: <https://github.com/rcarmo/bun-packrat/pull/2>
- merge commit: `3d4ae95ae8ad043ecbc4a075f99adc0adfaf40d8`
- release: <https://github.com/rcarmo/bun-packrat/releases/tag/v0.3.1>
- GitHub Actions run: <https://github.com/rcarmo/bun-packrat/actions/runs/35321043336>
- production manifest: `sha256:c95504fcaddb8baae132204ab4bf7496b875f7723da1dab729d74377e06e4bb7`
- previous v0.3.0 manifest: `sha256:6f0b54ce836a8d877043abee15e71d118b1b461de5f87f237c37764344058731`
- first accepted homepage after a controlled production stop/start: 195.793 ms
- immediate warm response: 3.223 ms
- successful settlement test: job 24 produced capture 2714, which appeared in the warmed homepage; deletion appeared on the next request
- filtered, search and bookmarklet-prefilled pages returned `Cache-Control: no-store` and current content
- production container healthy on VM 119 after verification

## Definition of done

- [x] Ordinary captures remain byte-exact before storage compression.
- [x] Oversized MHTML follows the two fixed image passes and stores only a fitting snapshot.
- [x] New and existing capture bodies follow the advantageous zstd policy.
- [x] Storage migration is idempotent, hash-checked and completed in production.
- [x] Homepage metadata queries are batched.
- [x] Only the unfiltered homepage remains resident.
- [x] Same-process and external writes reject stale completed or in-flight HTML.
- [x] Startup and settlement warming do not delay queue turnover.
- [x] Type checking and all 180 tests pass on Bun 1.4.0.
- [x] v0.3.1 is published and deployed by immutable digest.
- [x] Production restart latency, live query-bearing pages and post-settlement correctness are verified.

ArchiveBox hostname cutover remains separate operational work.
