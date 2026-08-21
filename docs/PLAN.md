# v0.3.0 implementation plan

Packrat v0.3.0 uses Bun 1.4 to add bounded image recompression for oversized MHTML and advantageous zstd compression for SQLite capture bodies. The v0.2.9 service is the implementation baseline.

Requirements: [PRD.md](PRD.md)

## Scope

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

Add an idempotent `migrate storage` CLI operation:

1. require a consistent backup before production use;
2. read capture bodies sequentially;
3. decompress each row according to its current marker;
4. verify the existing canonical SHA-256 before any write;
5. create a zstd candidate;
6. update one row in one short transaction only when zstd is smaller than the current stored BLOB;
7. retain `gzip` or `none` when either is smaller than or equal to zstd;
8. persist one changed, retained or failed outcome per row so bounded reruns advance safely;
9. report scanned, resumed, pending, changed, retained, failed, input and output byte totals;
10. support dry-run and bounded rehearsal options;
11. finish with SQLite integrity and full content-hash verification.

The migration does not run `VACUUM` automatically. The operator decides whether reclaimed free pages justify a separate maintenance window.

## Implementation sequence

| # | Work | Main files | Required evidence |
|---:|---|---|---|
| 1 | Add MHTML MIME-part rewrite fixtures and failing tests | `tests/canonical.test.ts`, `tests/phase1.test.ts` | Normal snapshots unchanged; colour, greyscale and failure paths reproduced |
| 2 | Add shared body codec helpers for `none`, `gzip` and `zstd` | `src/capture/canonical.ts`, `src/types.ts` | Round-trip and malformed-body tests |
| 3 | Implement sequential `Bun.Image` recompression and MHTML rebuilding | `src/capture/recompress.ts`, `src/capture/pipeline.ts` | JPEG/PNG/WebP replacement, MIME header preservation and skip cases |
| 4 | Add automatic advantageous zstd storage | capture pipeline, ArchiveBox importer, configuration | Stored codec selected by actual byte size; canonical hash unchanged |
| 5 | Add `migrate storage` | `src/cli/index.ts`, storage migration module | Dry-run, interrupted rerun and per-row atomicity tests |
| 6 | Add warnings, status/report fields and operational safeguards | pipeline, CLI, queue/container command | Fallback provenance and `--no-orphans` shutdown test |
| 7 | Run the release gate and resource benchmarks | full test suite and production-like fixtures | Type check, tests, diff check, RSS, latency and offline rendering results |
| 8 | Release and deploy v0.3.0 | package, workflow, production VM 119 | Immutable digest, backup, idle queue, migration report, `verify --all`, health and route checks |

## Test requirements

### Unit and integration

- normal MHTML below the limit remains byte-exact;
- a colour WebP quality-75 candidate is accepted when it fits;
- a greyscale WebP quality-75 candidate is attempted only after the colour candidate remains oversized;
- an image part is never replaced by a larger encoding;
- SVG, GIF and non-image MIME parts remain unchanged;
- MIME boundaries, `Content-Location`, transfer encoding and rewritten `Content-Type` remain valid;
- fallback failure stores no oversized body;
- successful fallback emits one deterministic warning;
- `none`, `gzip` and `zstd` bodies produce identical canonical bytes;
- new bodies use zstd only when it is smaller;
- migration verifies the hash before update and retains the current codec when zstd does not win;
- migration reruns safely after interruption;
- verification checks mixed-codec databases.

### Resource and browser checks

- process images sequentially on the 2 GiB production profile;
- record peak RSS and elapsed time for a representative oversized fixture;
- render accepted fallback MHTML through Full page, Article, Markdown and export routes;
- confirm zero remote resource requests and no scripts, forms or frames;
- test current Safari, Chromium and Firefox behaviour through decompressed responses;
- test watchdog exit with `--no-orphans` and confirm Chromium descendants terminate.

## Production procedure

1. Confirm the queue is idle and record current status.
2. Create and verify a consistent SQLite backup.
3. Deploy the immutable v0.3.0 image by digest without running storage migration automatically.
4. Check health, ordinary capture, oversized fallback and mixed-codec reads.
5. Stop capture work and run a bounded migration dry run.
6. Run `migrate storage` sequentially.
7. Run `verify --all`, API health checks and representative reading/export routes.
8. Record database, WAL and free-disk sizes. Run `VACUUM` only in a separate approved window if the expected reclaim exceeds its temporary disk requirement.
9. Keep the previous image digest and verified pre-migration database backup as the rollback pair.

## Definition of done

- [x] Ordinary captures remain byte-exact before storage compression.
- [x] Oversized MHTML follows the two fixed image passes and stores only a fitting snapshot.
- [x] No external or retained oversized original exists.
- [x] New capture bodies attempt zstd and use it only when smaller.
- [x] Existing `none`, `gzip` and `zstd` rows remain readable and verifiable.
- [x] Storage migration is idempotent, hash-checked, sequential and advantageous per row.
- [x] Type checking and the complete Bun test suite pass.
- [x] Resource and offline browser checks pass on the production profile.
- [x] Documentation matches the released CLI, configuration and behaviour.
- [ ] v0.3.0 is published, deployed by digest, migrated, verified and rollback-tested.

## Completed baseline

v0.2.9 provides canonical Chromium MHTML, byte-exact source PDFs, SQLite FTS5, offline Full page/Article/Markdown views, exports, queue recovery, ArchiveBox migration and original-PDF enrichment. It runs on Bun 1.4.0. ArchiveBox hostname cutover remains separate operational work.
