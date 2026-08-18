-- Migration 006: deduplicated source-PDF storage and resumable enrichment

CREATE TRIGGER IF NOT EXISTS captures_mode_pdf_insert
BEFORE INSERT ON captures
WHEN new.mode NOT IN ('article', 'full_page', 'imported_singlefile', 'metadata_only', 'pdf')
BEGIN
  SELECT RAISE(ABORT, 'invalid captures.mode');
END;

CREATE TRIGGER IF NOT EXISTS captures_mode_pdf_update
BEFORE UPDATE OF mode ON captures
WHEN new.mode NOT IN ('article', 'full_page', 'imported_singlefile', 'metadata_only', 'pdf')
BEGIN
  SELECT RAISE(ABORT, 'invalid captures.mode');
END;

CREATE TABLE IF NOT EXISTS pdf_blobs (
  id          INTEGER PRIMARY KEY,
  sha256      TEXT    NOT NULL UNIQUE,
  byte_size   INTEGER NOT NULL CHECK(byte_size >= 5),
  bytes       BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK(length(sha256) = 64),
  CHECK(length(bytes) = byte_size)
);

CREATE TABLE IF NOT EXISTS capture_pdfs (
  capture_id       INTEGER PRIMARY KEY REFERENCES captures(id) ON DELETE CASCADE,
  pdf_blob_id      INTEGER NOT NULL REFERENCES pdf_blobs(id) ON DELETE RESTRICT,
  source_kind      TEXT    NOT NULL CHECK(source_kind IN ('direct', 'archivebox_original')),
  source_mime      TEXT,
  source_filename  TEXT,
  source_locator   TEXT,
  attached_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_capture_pdfs_blob ON capture_pdfs(pdf_blob_id);

CREATE TABLE IF NOT EXISTS pdf_extractions (
  pdf_blob_id          INTEGER PRIMARY KEY REFERENCES pdf_blobs(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'running', 'succeeded', 'failed', 'timeout', 'encrypted', 'image_only')),
  page_count           INTEGER CHECK(page_count IS NULL OR page_count >= 0),
  extracted_text       TEXT,
  extracted_text_bytes INTEGER CHECK(extracted_text_bytes IS NULL OR extracted_text_bytes >= 0),
  text_truncated       INTEGER NOT NULL DEFAULT 0 CHECK(text_truncated IN (0, 1)),
  warnings             TEXT,
  error                TEXT,
  extractor            TEXT,
  started_at           TEXT,
  completed_at         TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pdf_extractions_status ON pdf_extractions(status);

CREATE TABLE IF NOT EXISTS archivebox_pdf_enrichment (
  archivebox_import_id INTEGER PRIMARY KEY REFERENCES archivebox_imports(id) ON DELETE CASCADE,
  status               TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'not_original_pdf', 'enriched', 'failed')),
  source_path          TEXT,
  source_size          INTEGER CHECK(source_size IS NULL OR source_size >= 0),
  source_sha256        TEXT,
  pdf_blob_id          INTEGER REFERENCES pdf_blobs(id) ON DELETE SET NULL,
  capture_id           INTEGER REFERENCES captures(id) ON DELETE SET NULL,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  detail               TEXT,
  processed_at         TEXT,
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK(source_sha256 IS NULL OR length(source_sha256) = 64)
);

CREATE INDEX IF NOT EXISTS idx_archivebox_pdf_enrichment_status
  ON archivebox_pdf_enrichment(status, archivebox_import_id);
CREATE INDEX IF NOT EXISTS idx_archivebox_pdf_enrichment_blob
  ON archivebox_pdf_enrichment(pdf_blob_id);

-- Source PDF bytes are retained only while at least one capture refers to them.
-- Provenance rows remain and have their blob reference cleared on deletion.
CREATE TRIGGER IF NOT EXISTS capture_pdfs_delete_orphan_blob
AFTER DELETE ON capture_pdfs
WHEN NOT EXISTS (SELECT 1 FROM capture_pdfs WHERE pdf_blob_id = old.pdf_blob_id)
 AND NOT EXISTS (SELECT 1 FROM archivebox_pdf_enrichment WHERE pdf_blob_id = old.pdf_blob_id)
BEGIN
  DELETE FROM pdf_blobs WHERE id = old.pdf_blob_id;
END;

INSERT INTO schema_migrations(version, name) VALUES(6, '006_source_pdfs');
