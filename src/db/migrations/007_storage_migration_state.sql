-- Migration 007: durable per-row capture-body storage migration progress

CREATE TABLE IF NOT EXISTS capture_storage_migrations (
  capture_id          INTEGER PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
  content_hash        TEXT NOT NULL,
  source_compression  TEXT NOT NULL,
  source_bytes        INTEGER NOT NULL,
  outcome             TEXT NOT NULL CHECK (outcome IN ('changed', 'retained', 'failed')),
  result_compression  TEXT NOT NULL,
  result_bytes        INTEGER NOT NULL,
  error               TEXT,
  processed_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_capture_storage_migrations_outcome
  ON capture_storage_migrations(outcome);

INSERT INTO schema_migrations(version, name) VALUES(7, '007_storage_migration_state');
