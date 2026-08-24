const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { STATUS, config, dbPath } = require('./constants');

function now() {
  return new Date().toISOString();
}

function extractVideoIdFromUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    const isShort = hostname.endsWith('youtu.be');
    const id = isShort ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {}
  return null;
}

function openDatabase() {
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
  try { db.exec('ALTER TABLE jobs ADD COLUMN video_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS jobs_video_id_idx ON jobs(video_id)'); } catch {}
  try {
    const rows = db.prepare('SELECT id, url FROM jobs WHERE video_id IS NULL').all();
    const upd = db.prepare('UPDATE jobs SET video_id = ? WHERE id = ?');
    for (const row of rows) {
      const vid = extractVideoIdFromUrl(row.url);
      if (vid) upd.run(vid, row.id);
    }
  } catch {}
  return db;
}

function createJob(db, id, url, videoId) {
  const timestamp = now();
  const vid = videoId || extractVideoIdFromUrl(url);
  db.prepare(`INSERT INTO jobs (id, url, video_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, url, vid, STATUS.QUEUED, timestamp, timestamp);
  return getJob(db, id);
}

function getJob(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

function findExistingJobByVideoId(db, videoId) {
  if (!videoId) return null;
  // Prefer canonical video_id column, fallback to URL substring for legacy rows without backfill
  let row = db.prepare(`SELECT * FROM jobs WHERE video_id = ? AND status IN ('queued','running','done') ORDER BY CASE status WHEN 'done' THEN 0 WHEN 'running' THEN 1 ELSE 2 END, created_at DESC LIMIT 1`).get(videoId);
  if (row) return row;
  row = db.prepare(`SELECT * FROM jobs WHERE video_id IS NULL AND url LIKE '%' || ? || '%' AND status IN ('queued','running','done') ORDER BY created_at DESC LIMIT 1`).get(videoId);
  return row || null;
}

function claimNextJob(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare(`SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`).get();
    if (!row) {
      db.exec('COMMIT');
      return null;
    }
    const timestamp = now();
    db.prepare(`UPDATE jobs SET status = ?, stage = ?, progress = 0, claimed_at = ?, last_heartbeat_at = ?, updated_at = ? WHERE id = ?`)
      .run(STATUS.RUNNING, null, timestamp, timestamp, timestamp, row.id);
    db.exec('COMMIT');
    return getJob(db, row.id);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function reclaimStaleJobs(db, staleAfterMs) {
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();
  const timestamp = now();
  return db.prepare(`
    UPDATE jobs
    SET status = ?, stage = NULL, progress = 0, claimed_at = NULL,
        last_heartbeat_at = NULL, error = NULL, updated_at = ?
    WHERE status = ? AND COALESCE(last_heartbeat_at, claimed_at, updated_at) < ?
  `).run(STATUS.QUEUED, timestamp, STATUS.RUNNING, cutoff).changes;
}

function updateStage(db, id, stage, progress) {
  const timestamp = now();
  db.prepare('UPDATE jobs SET stage = ?, progress = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(stage, progress, timestamp, id, STATUS.RUNNING);
}

function heartbeat(db, id) {
  const timestamp = now();
  db.prepare('UPDATE jobs SET last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(timestamp, timestamp, id, STATUS.RUNNING);
}

function markDone(db, id, title, markdown) {
  const timestamp = now();
  db.prepare(`UPDATE jobs SET status = ?, stage = NULL, progress = 100, title = ?, markdown = ?, error = NULL, last_heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = ?`)
    .run(STATUS.DONE, title || null, markdown, timestamp, id, STATUS.RUNNING);
}

function markFailed(db, id, error, stage) {
  const timestamp = now();
  db.prepare(`UPDATE jobs SET status = ?, stage = ?, error = ?, last_heartbeat_at = NULL, updated_at = ? WHERE id = ? AND status = ?`)
    .run(STATUS.FAILED, stage || null, error, timestamp, id, STATUS.RUNNING);
}

function closeDatabase(db) {
  db.close();
}

module.exports = { openDatabase, createJob, getJob, findExistingJobByVideoId, claimNextJob, reclaimStaleJobs, updateStage, heartbeat, markDone, markFailed, closeDatabase };
