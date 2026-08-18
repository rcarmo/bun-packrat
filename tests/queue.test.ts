/**
 * bun-packrat — job queue tests
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { openDatabase, runMigrations, createJob, claimNextJob, finishJob, recoverPendingCaptures, recoverStuckJobs, getJobById, getOrCreateUrl, insertCapture } from '../src/db/index.js';
import type { Database } from 'bun:sqlite';

let db: Database;

beforeEach(() => {
  db = openDatabase(':memory:');
  runMigrations(db);
});
afterEach(() => db.close());

describe('job lifecycle', () => {
  test('createJob inserts a queued job and returns an id', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    expect(id).toBeGreaterThan(0);

    const job = getJobById(db, id);
    expect(job).not.toBeNull();
    expect(job!.kind).toBe('capture');
    expect(job!.status).toBe('queued');
  });

  test('idempotency keys reuse an existing job', () => {
    const first = createJob(db, 'capture', { url: 'https://example.com/' }, 'same-request');
    const second = createJob(db, 'capture', { url: 'https://example.com/' }, 'same-request');
    expect(second).toBe(first);
    expect(db.query<{ n: number }, []>('SELECT COUNT(*) n FROM jobs').get()?.n).toBe(1);
  });

  test('claimNextJob atomically claims the oldest queued job', () => {
    const id1 = createJob(db, 'capture', { url: 'https://a.example.com/' });
    const id2 = createJob(db, 'capture', { url: 'https://b.example.com/' });

    const job = claimNextJob(db, ['capture']);
    expect(job).not.toBeNull();
    expect(job!.id).toBe(id1); // oldest first
    expect(job!.status).toBe('running');
    expect(job!.attempt_count).toBe(1);
  });

  test('claimNextJob returns null when no queued jobs exist', () => {
    const job = claimNextJob(db, ['capture']);
    expect(job).toBeNull();
  });

  test('claimNextJob does not return a running job', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    const first = claimNextJob(db, ['capture']);
    expect(first!.id).toBe(id);

    // Second claim should return null (job is now running)
    const second = claimNextJob(db, ['capture']);
    expect(second).toBeNull();
  });

  test('finishJob sets status to succeeded and records result', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    claimNextJob(db, ['capture']);
    finishJob(db, id, 'succeeded', { captureId: 42 });

    const job = getJobById(db, id);
    expect(job!.status).toBe('succeeded');
    expect(job!.result).toContain('captureId');
    expect(job!.finished_at).not.toBeNull();
    const attempt = db.query<{ outcome: string; ended_at: string }, [number]>('SELECT outcome, ended_at FROM attempts WHERE job_id = ?').get(id);
    expect(attempt?.outcome).toBe('succeeded');
    expect(attempt?.ended_at).not.toBeNull();
  });

  test('finishJob sets status to failed and records error', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    claimNextJob(db, ['capture']);
    finishJob(db, id, 'failed', undefined, 'Navigation timeout');

    const job = getJobById(db, id);
    expect(job!.status).toBe('failed');
    expect(job!.error).toBe('Navigation timeout');
  });

  test('recovery closes abandoned pending captures before retrying jobs', () => {
    const url = getOrCreateUrl(db, 'https://example.com/interrupted', 'https://example.com/interrupted');
    const id = insertCapture(db, { url_id:url.id,source_url:url.original,final_url:url.original,html:null,compression:'none',content_hash:null,html_size:null,title:null,author:null,site_name:null,published_at:null,excerpt:null,lang:null,extracted_text:null,mode:'full_page',status:'pending',capture_tool:'test',warnings:null });
    expect(recoverPendingCaptures(db)).toBe(1);
    expect(db.query<{ status:string; error:string },[number]>('SELECT status,error FROM captures WHERE id=?').get(id)).toEqual({ status:'failed', error:'Capture interrupted by process restart' });
    expect(recoverPendingCaptures(db)).toBe(0);
  });

  test('recoverStuckJobs resets running jobs to queued', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    claimNextJob(db, ['capture']); // puts it in running state

    // Simulate crash recovery
    const recovered = recoverStuckJobs(db);
    expect(recovered).toBe(1);

    const job = getJobById(db, id);
    expect(job!.status).toBe('queued');
    expect(job!.started_at).toBeNull();
  });

  test('recovery fails jobs that exhausted their attempts', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    db.exec('UPDATE jobs SET status = \'running\', attempt_count = max_attempts WHERE id = ?', [id]);
    expect(recoverStuckJobs(db)).toBe(0);
    expect(getJobById(db, id)?.status).toBe('failed');
  });

  test('recoverStuckJobs returns 0 when no running jobs exist', () => {
    createJob(db, 'capture', { url: 'https://example.com/' });
    const recovered = recoverStuckJobs(db);
    expect(recovered).toBe(0);
  });

  test('payload is stored and retrievable as JSON', () => {
    const id = createJob(db, 'capture', { url: 'https://example.com/test', mode: 'article' });
    const job = getJobById(db, id);
    const payload = JSON.parse(job!.payload!);
    expect(payload.url).toBe('https://example.com/test');
    expect(payload.mode).toBe('article');
  });
});

  test('cancelJob cancels only queued jobs', async () => {
    const { cancelJob } = await import('../src/db/index.js');
    const id = createJob(db, 'capture', { url: 'https://example.com/' });
    expect(cancelJob(db, id)).toBe(true);
    expect(getJobById(db, id)?.status).toBe('cancelled');
    expect(cancelJob(db, id)).toBe(false);
  });

describe('tag management', () => {
  test('addTagToCapture and getCaptureTags round-trip', async () => {
    const { getOrCreateUrl, insertCapture, addTagToCapture, getCaptureTags, removeTagFromCapture } = await import('../src/db/index.js');

    const url = getOrCreateUrl(db, 'https://example.com/', 'https://example.com/');
    const id = insertCapture(db, {
      url_id: url.id, source_url: 'https://example.com/', final_url: 'https://example.com/',
      html: null, compression: 'none', content_hash: null, html_size: null,
      title: 'Tagged', author: null, site_name: null, published_at: null,
      excerpt: null, lang: null, extracted_text: null,
      mode: 'article', status: 'succeeded', capture_tool: 'test/0', warnings: null,
    });

    addTagToCapture(db, id, 'science');
    addTagToCapture(db, id, 'energy');
    addTagToCapture(db, id, 'science'); // duplicate — should not double-insert

    const tags = getCaptureTags(db, id);
    expect(tags).toEqual(['energy', 'science']);

    expect(removeTagFromCapture(db, id, '  science  ')).toBe(true);
    expect(removeTagFromCapture(db, id, 'science')).toBe(false);
    expect(getCaptureTags(db, id)).toEqual(['energy']);
    expect(db.query<{ n:number },[string]>('SELECT count(*) n FROM tags WHERE name=?').get('science')?.n).toBe(0);

    expect(removeTagFromCapture(db, id, 'energy')).toBe(true);
    expect(getCaptureTags(db, id)).toEqual([]);
    expect(db.query<{ n:number },[]>('SELECT count(*) n FROM tags').get()?.n).toBe(0);
  });
});
