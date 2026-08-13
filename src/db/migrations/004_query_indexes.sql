-- Migration 004: indexes used by filtered browsing and capture history repair

CREATE INDEX IF NOT EXISTS idx_captures_url_status_date
  ON captures(url_id, status, captured_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_metadata_capture_key
  ON metadata(capture_id, key);

INSERT INTO schema_migrations(version, name) VALUES(4, '004_query_indexes');
