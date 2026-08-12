-- Migration 002: tighten constraints and repair indexes

CREATE INDEX IF NOT EXISTS idx_jobs_claim
  ON jobs(status, kind, queued_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS idx_capture_tags_tag_id ON capture_tags(tag_id);

-- Ensure FTS is consistent for databases created or modified by earlier builds.
INSERT INTO captures_fts(captures_fts) VALUES('rebuild');

INSERT INTO schema_migrations(version, name) VALUES(2, '002_constraints');
