-- Migration 005: make canonical body availability metadata-queryable
--
-- body_format is added conditionally by runMigrations() so interrupted upgrades
-- can resume. Existing bodies are classified one at a time by runMigrations();
-- ordinary metadata queries never need to read captures.html.

CREATE INDEX IF NOT EXISTS idx_captures_body_format ON captures(body_format);

-- Updating body_format must not churn the full-text index. Only changes to
-- indexed capture columns require the FTS delete/insert pair.
DROP TRIGGER IF EXISTS captures_au;
CREATE TRIGGER captures_au AFTER UPDATE OF title, site_name, author, source_url, url_id, extracted_text ON captures BEGIN
  INSERT INTO captures_fts(captures_fts, rowid, title, site_name, author, source_url, domain, extracted_text)
  VALUES('delete', old.id, old.title, old.site_name, old.author, old.source_url,
    (SELECT domain FROM urls WHERE id = old.url_id),
    old.extracted_text);
  INSERT INTO captures_fts(rowid, title, site_name, author, source_url, domain, extracted_text)
  SELECT new.id, new.title, new.site_name, new.author, new.source_url,
    (SELECT domain FROM urls WHERE id = new.url_id),
    new.extracted_text;
END;

CREATE TRIGGER IF NOT EXISTS captures_body_format_insert
BEFORE INSERT ON captures
WHEN new.body_format IS NOT NULL AND new.body_format NOT IN ('html', 'mhtml')
BEGIN
  SELECT RAISE(ABORT, 'invalid captures.body_format');
END;

CREATE TRIGGER IF NOT EXISTS captures_body_format_update
BEFORE UPDATE OF body_format ON captures
WHEN new.body_format IS NOT NULL AND new.body_format NOT IN ('html', 'mhtml')
BEGIN
  SELECT RAISE(ABORT, 'invalid captures.body_format');
END;

INSERT INTO schema_migrations(version, name) VALUES(5, '005_capture_body_metadata');
