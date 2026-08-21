import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, runMigrations } from '../src/db/index.js';

describe('database upgrade and backup', () => {
  test('upgrades an existing migration-1 database through the latest version', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packrat-upgrade-'));
    const path = join(dir, 'old.sqlite');
    try {
      const old = new Database(path, { create: true });
      old.exec(readFileSync(join(import.meta.dir, '../src/db/migrations/001_initial.sql'), 'utf-8'));
      old.close();

      const db = openDatabase(path);
      runMigrations(db);
      const versions = db.query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7]);
      const columns = db.query<{ name: string }, []>('PRAGMA table_info(captures)').all().map((r) => r.name);
      expect(columns).toContain('note');
      expect(columns).toContain('capture_duration_ms');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('repairs a partially applied migration 3 before recording it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packrat-partial-upgrade-'));
    const path = join(dir, 'partial.sqlite');
    try {
      const old = new Database(path, { create: true });
      old.exec(readFileSync(join(import.meta.dir, '../src/db/migrations/001_initial.sql'), 'utf-8'));
      old.exec(readFileSync(join(import.meta.dir, '../src/db/migrations/002_constraints.sql'), 'utf-8'));
      old.exec('ALTER TABLE captures ADD COLUMN error TEXT');
      old.close();

      const db = openDatabase(path);
      runMigrations(db);
      const columns = db.query<{ name:string },[]>('PRAGMA table_info(captures)').all().map((column) => column.name);
      expect(columns).toContain('error');
      expect(columns).toContain('note');
      expect(columns).toContain('capture_duration_ms');
      expect(db.query<{ n:number },[]>('SELECT COUNT(*) n FROM schema_migrations WHERE version=3').get()?.n).toBe(1);
      expect(db.query<{ n:number },[]>('SELECT COUNT(*) n FROM schema_migrations WHERE version=7').get()?.n).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('VACUUM INTO creates a standalone integrity-clean backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'packrat-backup-'));
    const source = join(dir, 'source.sqlite');
    const backup = join(dir, 'backup.sqlite');
    try {
      const db = openDatabase(source);
      runMigrations(db);
      db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
      db.close();
      const restored = openDatabase(backup);
      const integrity = restored.query<{ integrity_check: string }, []>('PRAGMA integrity_check').get();
      expect(integrity?.integrity_check).toBe('ok');
      expect(restored.query<{ n: number }, []>('SELECT COUNT(*) n FROM schema_migrations').get()?.n).toBe(7);
      restored.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
