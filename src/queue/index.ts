/**
 * bun-packrat — in-process job queue
 *
 * Polls the `jobs` SQLite table for pending work, dispatches to handlers,
 * and updates job state atomically. On startup it recovers any jobs left
 * in `running` state from a previous crash.
 *
 * Supported job kinds:
 *   capture   — queue a URL for Playwright archival
 */

import type { Database } from 'bun:sqlite';
import type { PackratConfig } from '../types.js';
import {
  claimNextJob,
  finishJob,
  recoverPendingCaptures,
  recoverStuckJobs,
} from '../db/index.js';
import { capturePage } from '../capture/pipeline.js';

type HandlerResult = Record<string, unknown>;

export interface QueueOptions {
  db: Database;
  config: PackratConfig;
  /** Poll interval ms (default 2 s) */
  pollIntervalMs?: number;
  /** Max concurrent jobs (default from config) */
  maxConcurrent?: number;
}

const HANDLED_KINDS = ['capture'] as const;

export class JobQueue {
  private db: Database;
  private config: PackratConfig;
  private pollIntervalMs: number;
  private maxConcurrent: number;
  private active = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(opts: QueueOptions) {
    this.db = opts.db;
    this.config = opts.config;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.maxConcurrent = opts.maxConcurrent ?? opts.config.maxConcurrentCaptures;
  }

  start(): void {
    if (this.timer) return;

    // Close abandoned pending rows before retrying jobs from a previous crash.
    const interruptedCaptures = recoverPendingCaptures(this.db);
    if (interruptedCaptures > 0) {
      console.log(JSON.stringify({ event: 'captures.recovered', count: interruptedCaptures }));
    }
    const recovered = recoverStuckJobs(this.db);
    if (recovered > 0) {
      console.log(JSON.stringify({ event: 'queue.recovered', count: recovered }));
    }

    this.stopping = false;
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.poll();
    console.log(JSON.stringify({ event: 'queue.started', pollIntervalMs: this.pollIntervalMs }));
  }

  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    console.log(JSON.stringify({ event: 'queue.stopped' }));
  }

  /** Current number of running jobs */
  get activeCount(): number {
    return this.active;
  }

  private poll(): void {
    if (this.stopping) return;
    if (this.active >= this.maxConcurrent) return;

    const job = claimNextJob(this.db, [...HANDLED_KINDS]);
    if (!job) return;

    this.active++;
    this.runJob(job).finally(() => { this.active--; });

    // Opportunistically claim another job if capacity allows
    if (this.active < this.maxConcurrent) {
      this.poll();
    }
  }

  private async runJob(job: any): Promise<void> {
    let payload: Record<string, unknown> = {};
    try {
      payload = job.payload ? JSON.parse(job.payload) : {};
    } catch {
      finishJob(this.db, job.id, 'failed', undefined, 'Invalid job payload JSON');
      return;
    }

    console.log(JSON.stringify({ event: 'job.started', jobId: job.id, kind: job.kind }));

    try {
      let result: HandlerResult;

      switch (job.kind as string) {
        case 'capture':
          result = await this.handleCapture(job.id, payload);
          break;
        default:
          throw new Error(`Unknown job kind: ${job.kind}`);
      }

      finishJob(this.db, job.id, 'succeeded', result);
      console.log(JSON.stringify({ event: 'job.succeeded', jobId: job.id, kind: job.kind }));
    } catch (err: any) {
      const errMsg = err?.message ?? String(err);
      finishJob(this.db, job.id, 'failed', undefined, errMsg);
      console.error(JSON.stringify({ event: 'job.failed', jobId: job.id, kind: job.kind, error: errMsg }));
    }
  }

  private async handleCapture(
    jobId: number,
    payload: Record<string, unknown>,
  ): Promise<HandlerResult> {
    const url = payload.url as string;
    if (!url) throw new Error('capture job missing url in payload');

    // Playwright can occasionally lose its Chromium process without rejecting
    // the outstanding protocol promise. The abandoned promise cannot be
    // cancelled safely because it still closes over the shared database, so a
    // watchdog restarts the process. Startup recovery requeues the attempt and
    // max_attempts prevents an infinite crash loop.
    const watchdogMs = Math.max(5 * 60_000, this.config.captureTimeoutMs * 4);
    const watchdog = setTimeout(() => {
      console.error(JSON.stringify({ event:'capture.watchdog', jobId, url, watchdogMs }));
      process.exit(70);
    }, watchdogMs);
    watchdog.unref?.();
    let result;
    try {
      result = await capturePage(url, {
        config: this.config,
        db: this.db,
        force: payload.force === true,
      });
    } finally {
      clearTimeout(watchdog);
    }

    // Link the job to its capture
    this.db.exec('UPDATE jobs SET capture_id = ? WHERE id = ?', [result.captureId, jobId]);

    return {
      captureId: result.captureId,
      mode: result.mode,
      title: result.title,
      finalUrl: result.finalUrl,
      htmlSize: result.htmlSize,
    };
  }
}
