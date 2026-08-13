-- Migration 003: non-import PRD application features
-- Columns are added conditionally by runMigrations() so interrupted/manual
-- pre-release upgrades can safely resume without duplicate-column failures.

CREATE INDEX IF NOT EXISTS idx_captures_mode ON captures(mode);
CREATE INDEX IF NOT EXISTS idx_captures_final_url ON captures(final_url);
CREATE INDEX IF NOT EXISTS idx_captures_published_at ON captures(published_at);

INSERT INTO schema_migrations(version, name) VALUES(3, '003_application_features');
