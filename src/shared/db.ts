// Pragmatic shared-model: app+worker share JobRow via jobs-data volume.
// Balanced today because volatility=low (supporting, single-team, same image,
// polling via BEGIN IMMEDIATE) — not VOLATILITY shields the tight Model+High-Distance coupling.
// Revisit if queue/history UI lands (volatility → high) — extract JobStorePort / published language via publicJob().
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { config, dbPath } from './config.ts';
import type { JobStatus } from './job.ts';
import { STATUS } from './job.ts';

export interface JobRow {
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

export function extractVideoIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isShort = hostname.endsWith('youtu.be');
    const id = isShort ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {}
  return null;
}

function asJobRow(row: unknown): JobRow {
  return row as JobRow;
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
): JobRow | null {
  const timestamp = now();
  const vid = videoId || extractVideoIdFromUrl(url);
  db.prepare(
    `INSERT INTO jobs (id, url, video_id, lang, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, url, vid, lang ?? null, STATUS.QUEUED, timestamp, timestamp);
  return getJob(db, id);
}

export function getJob(db: DatabaseSync, id: string): JobRow | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  return row ? asJobRow(row) : null;
}

// Dedup is per video AND per output language: requesting the same video in a
// different language must produce a new note. Legacy NULL langs count as 'en'.
export function findExistingJobByVideoId(db: DatabaseSync, videoId: string | null, lang = 'en'): JobRow | null {
  if (!videoId) return null;
  // Prefer canonical video_id column, fallback to URL substring for legacy rows without backfill
  let row = db
    .prepare(
      `SELECT * FROM jobs WHERE video_id = ? AND COALESCE(lang, 'en') = ? AND status IN ('queued','running','done') ORDER BY CASE status WHEN 'done' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`,
    )
    .get(videoId, lang);
  if (row) return asJobRow(row);
  row = db
    .prepare(
      `SELECT * FROM jobs WHERE video_id IS NULL AND url LIKE '%' || ? || '%' AND COALESCE(lang, 'en') = ? AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1`,
    )
    .get(videoId, lang);
  return row ? asJobRow(row) : null;
}

export function claimNextJob(db: DatabaseSync): JobRow | null {
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

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
