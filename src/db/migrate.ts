#!/usr/bin/env bun
/**
 * bun-packrat — migration runner
 * Usage: bun run src/db/migrate.ts [db-path]
 */

import { openDatabase, runMigrations } from './index.js';
import { loadConfig } from '../config.js';

const config = loadConfig();
const dbPath = process.argv[2] ?? config.dbPath;

console.log(`[migrate] Opening database: ${dbPath}`);
const db = openDatabase(dbPath);
runMigrations(db);
console.log('[migrate] All migrations applied.');
db.close();
