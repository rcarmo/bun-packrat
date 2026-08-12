-- Migration 003: non-import PRD application features

ALTER TABLE captures ADD COLUMN error TEXT;
ALTER TABLE captures ADD COLUMN note TEXT;
ALTER TABLE captures ADD COLUMN capture_duration_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_captures_mode ON captures(mode);
CREATE INDEX IF NOT EXISTS idx_captures_final_url ON captures(final_url);
CREATE INDEX IF NOT EXISTS idx_captures_published_at ON captures(published_at);

INSERT INTO schema_migrations(version, name) VALUES(3, '003_application_features');
