-- Migration 001: initial schema
-- bun-packrat Phase 1

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT    NOT NULL,
  applied_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Normalised URL identity
CREATE TABLE IF NOT EXISTS urls (
  id             INTEGER PRIMARY KEY,
  normalised     TEXT    NOT NULL UNIQUE,          -- canonical normalised URL
  original       TEXT    NOT NULL,                 -- first-seen original spelling
  domain         TEXT    NOT NULL,                 -- extracted hostname
  latest_capture INTEGER REFERENCES captures(id),
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_urls_domain ON urls(domain);
CREATE INDEX IF NOT EXISTS idx_urls_latest_capture ON urls(latest_capture);

-- Captures: one row per archived representation
CREATE TABLE IF NOT EXISTS captures (
  id              INTEGER PRIMARY KEY,
  url_id          INTEGER NOT NULL REFERENCES urls(id),

  -- URLs
  source_url      TEXT    NOT NULL,                -- URL as submitted
  final_url       TEXT    NOT NULL,                -- URL after redirects
  
  -- Content
  html            BLOB,                            -- self-contained HTML (possibly compressed)
  compression     TEXT    NOT NULL DEFAULT 'none', -- none | gzip | zstd
  content_hash    TEXT,                            -- SHA-256 of uncompressed HTML
  html_size       INTEGER,                         -- uncompressed byte length
  
  -- Metadata
  title           TEXT,
  author          TEXT,
  site_name       TEXT,
  published_at    TEXT,
  excerpt         TEXT,
  lang            TEXT,
  extracted_text  TEXT,                            -- plain text for FTS
  
  -- Capture provenance
  mode            TEXT    NOT NULL DEFAULT 'article', -- article | full_page | imported_singlefile | metadata_only
  status          TEXT    NOT NULL DEFAULT 'pending', -- pending | succeeded | failed | cancelled
  capture_tool    TEXT    NOT NULL DEFAULT 'packrat/0.1.0',
  warnings        TEXT,                            -- JSON array of warning strings
  
  -- Timestamps
  captured_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_captures_url_id     ON captures(url_id);
CREATE INDEX IF NOT EXISTS idx_captures_status     ON captures(status);
CREATE INDEX IF NOT EXISTS idx_captures_captured_at ON captures(captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_captures_content_hash ON captures(content_hash);

-- Redirect / alias URL tracking
CREATE TABLE IF NOT EXISTS capture_aliases (
  id         INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  url        TEXT    NOT NULL,
  kind       TEXT    NOT NULL DEFAULT 'redirect',  -- redirect | original | canonical
  UNIQUE(capture_id, url)
);

CREATE INDEX IF NOT EXISTS idx_capture_aliases_url ON capture_aliases(url);

-- Extensible metadata (key/value, not promoted to captures columns)
CREATE TABLE IF NOT EXISTS metadata (
  id         INTEGER PRIMARY KEY,
  capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  key        TEXT    NOT NULL,
  value      TEXT,
  UNIQUE(capture_id, key)
);

-- Tags
CREATE TABLE IF NOT EXISTS tags (
  id   INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS capture_tags (
  capture_id INTEGER NOT NULL REFERENCES captures(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (capture_id, tag_id)
);

-- Jobs: capture, import and export
CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY,
  kind        TEXT    NOT NULL,                    -- capture | import_archivebox | export
  status      TEXT    NOT NULL DEFAULT 'queued',   -- queued | running | succeeded | failed | cancelled
  capture_id  INTEGER REFERENCES captures(id),
  payload     TEXT,                                -- JSON: input parameters
  result      TEXT,                                -- JSON: output/result
  error       TEXT,                                -- last error message
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  queued_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  started_at  TEXT,
  finished_at TEXT,
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_kind       ON jobs(kind);
CREATE INDEX IF NOT EXISTS idx_jobs_queued_at  ON jobs(queued_at);

-- Per-job attempt diagnostics
CREATE TABLE IF NOT EXISTS attempts (
  id         INTEGER PRIMARY KEY,
  job_id     INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt    INTEGER NOT NULL,
  started_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  ended_at   TEXT,
  outcome    TEXT,                                 -- succeeded | failed
  error      TEXT,
  log        TEXT                                  -- bounded diagnostic text
);

CREATE INDEX IF NOT EXISTS idx_attempts_job_id ON attempts(job_id);

-- ArchiveBox migration provenance (Phase 3, table defined now)
CREATE TABLE IF NOT EXISTS archivebox_imports (
  id              INTEGER PRIMARY KEY,
  ab_id           TEXT    NOT NULL UNIQUE,          -- ArchiveBox snapshot id/timestamp key
  ab_url          TEXT    NOT NULL,
  ab_timestamp    TEXT,
  ab_status       TEXT,
  ab_paths        TEXT,                             -- JSON: extractor output paths found
  ab_source_hash  TEXT,                             -- hash of best source file
  capture_id      INTEGER REFERENCES captures(id),
  outcome         TEXT,                             -- imported | duplicate | skipped | failed
  outcome_detail  TEXT,
  processed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_ab_imports_outcome ON archivebox_imports(outcome);
CREATE INDEX IF NOT EXISTS idx_ab_imports_ab_url  ON archivebox_imports(ab_url);

-- FTS5 full-text search index
CREATE VIRTUAL TABLE IF NOT EXISTS captures_fts USING fts5(
  title,
  site_name,
  author,
  source_url,
  domain,
  extracted_text,
  content='captures',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- FTS triggers to keep index in sync
CREATE TRIGGER IF NOT EXISTS captures_ai AFTER INSERT ON captures BEGIN
  INSERT INTO captures_fts(rowid, title, site_name, author, source_url, domain, extracted_text)
  SELECT new.id, new.title, new.site_name, new.author, new.source_url,
    (SELECT domain FROM urls WHERE id = new.url_id),
    new.extracted_text;
END;

CREATE TRIGGER IF NOT EXISTS captures_ad AFTER DELETE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, title, site_name, author, source_url, domain, extracted_text)
  VALUES('delete', old.id, old.title, old.site_name, old.author, old.source_url,
    (SELECT domain FROM urls WHERE id = old.url_id),
    old.extracted_text);
END;

CREATE TRIGGER IF NOT EXISTS captures_au AFTER UPDATE ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, title, site_name, author, source_url, domain, extracted_text)
  VALUES('delete', old.id, old.title, old.site_name, old.author, old.source_url,
    (SELECT domain FROM urls WHERE id = old.url_id),
    old.extracted_text);
  INSERT INTO captures_fts(rowid, title, site_name, author, source_url, domain, extracted_text)
  SELECT new.id, new.title, new.site_name, new.author, new.source_url,
    (SELECT domain FROM urls WHERE id = new.url_id),
    new.extracted_text;
END;

-- Record this migration
INSERT INTO schema_migrations(version, name) VALUES(1, '001_initial');
