// Pragmatic shared-model: app+worker share the jobs-data volume (single-team,
// same image, polling via BEGIN IMMEDIATE). Volatility stays low — not VOLATILITY shielding
// a tight Model+High-Distance coupling.
// Revisit if queue/history UI lands (volatility → high) — extract JobStorePort / published language via publicJob().
// SQLite outbound adapter. Rows come from sqlite with snake_case columns;
// the adapter maps them to the domain Job entity before they cross the port
// boundary.
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { JobStatus } from '../../../domain/job/entity.ts';
import { STATUS } from '../../../domain/job/entity.ts';
import { config, dbPath } from '../../../shared/config.ts';

interface JobDbRow {
  id: string;
  url: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  title: string | null;
  error: string | null;
  markdown: string | null;
  video_id: string | null;
  lang: string | null;
  created_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

import type { JobStore } from '../../../application/ports/job-store.ts';
import { DEDUP_STATUSES } from '../../../domain/job/dedup.ts';
import {
  createJobEntity,
  heartbeatJob,
  type Job,
  markJobDone,
  markJobFailed,
  retryJob,
  STAGES,
  type Stage,
  updateJobStage,
} from '../../../domain/job/entity.ts';
// Single source for the URL rules lives in the domain (phase 1A). Imported
// for local use and re-exported so existing import paths (`shared/db.ts`)
// keep working.
import { extractVideoIdFromUrl } from '../../../domain/youtube/validation.ts';

export { extractVideoIdFromUrl };

function asJobDbRow(row: unknown): JobDbRow {
  return row as JobDbRow;
}

export function openDatabase(): DatabaseSync {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = new DatabaseSync(dbPath());
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 10000;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
      stage TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      title TEXT,
      error TEXT,
      markdown TEXT,
      created_at TEXT NOT NULL,
      claimed_at TEXT,
      last_heartbeat_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_status_created_idx ON jobs(status, created_at);
  `);
  // Deduplication support: store canonical video_id and backfill legacy rows
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN video_id TEXT');
  } catch {}
  try {
    db.exec('CREATE INDEX IF NOT EXISTS jobs_video_id_idx ON jobs(video_id)');
  } catch {}
  // Per-job output language (ISO 639-1); legacy rows keep NULL, read as 'en'.
  try {
    db.exec('ALTER TABLE jobs ADD COLUMN lang TEXT');
  } catch {}
  try {
    const rows = db.prepare('SELECT id, url FROM jobs WHERE video_id IS NULL').all();
    const upd = db.prepare('UPDATE jobs SET video_id = ? WHERE id = ?');
    for (const row of rows) {
      const legacy = row as { id?: unknown; url?: unknown };
      if (typeof legacy.id !== 'string' || typeof legacy.url !== 'string') continue;
      const vid = extractVideoIdFromUrl(legacy.url);
      if (vid) upd.run(vid, legacy.id);
    }
  } catch {}
  return db;
}

export function createJob(
  db: DatabaseSync,
  id: string,
  url: string,
  videoId?: string | null,
  lang?: string | null,
): Job | null {
  const timestamp = now();
  const vid = videoId || extractVideoIdFromUrl(url);
  db.prepare(
    `INSERT INTO jobs (id, url, video_id, lang, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, vid, lang ?? null, STATUS.QUEUED, timestamp, timestamp);
  return getJob(db, id);
}

export function getJob(db: DatabaseSync, id: string): Job | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? jobDbRowToJob(asJobDbRow(row)) : null;
}

// Dedup is per video AND per output language: requesting the same video in a
// different language must produce a new note. Legacy NULL langs count as 'en'.
export function findExistingJobByVideoId(db: DatabaseSync, videoId: string | null, lang = 'en'): Job | null {
  if (!videoId) return null;
  const inStatuses = DEDUP_STATUSES.map((s) => `'${s}'`).join(',');
  // Prefer canonical video_id column, fallback to URL substring for legacy rows without backfill
  let row = db
    .prepare(
      `SELECT * FROM jobs WHERE video_id = ? AND COALESCE(lang, 'en') = ? AND status IN (${inStatuses}) ORDER BY CASE status WHEN 'done' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`,
    )
    .get(videoId, lang);
  if (row) return jobDbRowToJob(asJobDbRow(row));
  row = db
    .prepare(
      `SELECT * FROM jobs WHERE video_id IS NULL AND url LIKE '%' || ? || '%' AND COALESCE(lang, 'en') = ? AND status IN (${inStatuses}) ORDER BY created_at DESC LIMIT 1`,
    )
    .get(videoId, lang);
  return row ? jobDbRowToJob(asJobDbRow(row)) : null;
}

export function claimNextJob(db: DatabaseSync): Job | null {
  db.exec('BEGIN IMMEDIATE');
  try {
    const next = db.prepare(`SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get() as
      | { id?: unknown }
      | undefined;
    if (!next || typeof next.id !== 'string') {
      db.exec('COMMIT');
      return null;
    }
    const timestamp = now();
    db.prepare(
      `UPDATE jobs SET status = ?, stage = ?, progress = 0, claimed_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`,
    ).run(STATUS.RUNNING, null, timestamp, timestamp, timestamp, next.id);
    db.exec('COMMIT');
    return getJob(db, next.id);
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    throw error;
  }
}

export function reclaimStaleJobs(db: DatabaseSync, staleAfterMs: number): number {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const timestamp = now();
  const result = db
    .prepare(`
    UPDATE jobs
    SET status = ?, stage = NULL, progress = 0, claimed_at = NULL,
        last_heartbeat_at = NULL, error = NULL, updated_at = ?
    WHERE status = ? AND COALESCE(last_heartbeat_at, claimed_at, updated_at) < ?
  `)
    .run(STATUS.QUEUED, timestamp, STATUS.RUNNING, cutoff);
  return Number(result.changes);
}

export function updateStage(db: DatabaseSync, id: string, stage: string, progress: number): void {
  const timestamp = now();
  db.prepare('UPDATE jobs SET stage = ?, progress = ?, updated_at = ? WHERE id = ? AND status = ?').run(
    stage,
    progress,
    timestamp,
    id,
    STATUS.RUNNING,
  );
}

export function heartbeat(db: DatabaseSync, id: string): void {
  const timestamp = now();
  db.prepare('UPDATE jobs SET last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = ?').run(
    timestamp,
    timestamp,
    id,
    STATUS.RUNNING,
  );
}

export function markDone(db: DatabaseSync, id: string, title: string | null, markdown: string): void {
  const timestamp = now();
  db.prepare(
    `UPDATE jobs SET status = ?, stage = NULL, progress = 100, title = ?, markdown = ?, error = NULL, last_heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(STATUS.DONE, title || null, markdown, timestamp, id, STATUS.RUNNING);
}

export function markFailed(db: DatabaseSync, id: string, error: string, stage: string | null): void {
  const timestamp = now();
  db.prepare(
    `UPDATE jobs SET status = ?, stage = ?, error = ?, last_heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = ?`,
  ).run(STATUS.FAILED, stage || null, error, timestamp, id, STATUS.RUNNING);
}

/**
 * Re-queue a failed job so the worker picks it up again. Only `failed` rows
 * are eligible: the conditional UPDATE makes a second concurrent retry (or a
 * retry racing the worker) a no-op returning null instead of double-queueing.
 * Error/stage/progress/lease are cleared exactly like a stale reclaim, while
 * url/video_id/lang/title and the artifacts on disk are preserved — the
 * pipeline resumes from those artifacts instead of paying for them again.
 * Returns the re-queued row, or null when the job is unknown or not failed.
 */
export function retryFailedJob(db: DatabaseSync, id: string): Job | null {
  const timestamp = now();
  const result = db
    .prepare(
      `UPDATE jobs SET status = ?, stage = NULL, progress = 0, error = NULL,
        claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?
       WHERE id = ? AND status = ?`,
    )
    .run(STATUS.QUEUED, timestamp, id, STATUS.FAILED);
  return Number(result.changes) === 1 ? getJob(db, id) : null;
}

export function listDoneJobs(db: DatabaseSync, limit: number, search?: string, offset = 0): Job[] {
  const term = search?.trim();
  if (term) {
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = db
      .prepare(
        `SELECT * FROM jobs WHERE status = ? AND title LIKE '%' || ? || '%' ESCAPE '\\' ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(STATUS.DONE, escaped, limit, offset);
    return rows.map((row) => jobDbRowToJob(asJobDbRow(row)));
  }
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(STATUS.DONE, limit, offset);
  return rows.map((row) => jobDbRowToJob(asJobDbRow(row)));
}

export function countDoneJobs(db: DatabaseSync, search?: string): number {
  const term = search?.trim();
  if (term) {
    const escaped = term.replace(/[\\%_]/g, (c) => `\\${c}`);
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = ? AND title LIKE '%' || ? || '%' ESCAPE '\\'`)
      .get(STATUS.DONE, escaped) as { c: number };
    return Number(row.c);
  }
  const row = db.prepare(`SELECT COUNT(*) AS c FROM jobs WHERE status = ?`).get(STATUS.DONE) as { c: number };
  return Number(row.c);
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}

/**
 * Maps a raw SQLite row to the domain Job entity.
 */
export function jobDbRowToJob(row: JobDbRow): Job {
  return {
    id: row.id,
    url: row.url,
    videoId: row.video_id,
    lang: row.lang,
    status: row.status,
    stage: (STAGES as readonly (string | null | undefined)[]).includes(row.stage) ? (row.stage as Stage) : null,
    progress: row.progress,
    title: row.title,
    error: row.error,
    markdown: row.markdown,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    updatedAt: row.updated_at,
  };
}

/**
 * SQLite JobStore adapter: delegates to the SQL helpers in this file and
 * maps rows to the domain Job entity; `updateStage`/`mark*` first validate
 * through the entity transitions so the domain owns the state machine
 * while the adapter only persists the result.
 */
export function createSqliteJobStore(db: DatabaseSync): JobStore {
  return {
    create(input) {
      const videoId = input.videoId || extractVideoIdFromUrl(input.url);
      createJobEntity({ id: input.id, url: input.url, videoId: videoId ?? null, lang: input.lang ?? null }, now());
      const row = createJob(db, input.id, input.url, videoId, input.lang ?? null);
      return row ? row : null;
    },
    get(id) {
      const row = getJob(db, id);
      return row ? row : null;
    },
    findExisting(videoId, lang) {
      const row = findExistingJobByVideoId(db, videoId, lang);
      return row ? row : null;
    },
    claimNext() {
      const row = claimNextJob(db);
      return row ? row : null;
    },
    reclaimStaleJobs(staleAfterMs) {
      return reclaimStaleJobs(db, staleAfterMs);
    },
    updateStage(id, stage, progress) {
      const row = getJob(db, id);
      if (!row) return null;
      updateJobStage(row, stage, progress, now());
      updateStage(db, id, stage, progress);
      const after = getJob(db, id);
      return after ? after : null;
    },
    heartbeat(id) {
      const row = getJob(db, id);
      if (!row) return null;
      const job = row;
      if (job.status !== STATUS.RUNNING) return job;
      heartbeatJob(job, now());
      heartbeat(db, id);
      const after = getJob(db, id);
      return after ? after : job;
    },
    markDone(id, title, markdown) {
      const row = getJob(db, id);
      if (!row) return null;
      markJobDone(row, title, markdown, now());
      markDone(db, id, title, markdown);
      const after = getJob(db, id);
      return after ? after : null;
    },
    markFailed(id, error, stage) {
      const row = getJob(db, id);
      if (!row) return null;
      const knownStage = stage && (STAGES as readonly string[]).includes(stage) ? (stage as Stage) : null;
      markJobFailed(row, error, knownStage, now());
      markFailed(db, id, error, stage || null);
      const after = getJob(db, id);
      return after ? after : null;
    },
    retryFailed(id) {
      const row = getJob(db, id);
      if (!row || row.status !== STATUS.FAILED) return null;
      retryJob(row, now());
      const retried = retryFailedJob(db, id);
      return retried ? retried : null;
    },
    listDone(limit, search, offset) {
      return listDoneJobs(db, limit, search, offset);
    },
    countDone(search) {
      return countDoneJobs(db, search);
    },
  };
}
