const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { STATUS, config, dbPath } = require('./constants');

function now() {
  return new Date().toISOString();
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
  return db;
}

function createJob(db, id, url) {
  const timestamp = now();
  db.prepare(`INSERT INTO jobs (id, url, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .run(id, url, STATUS.QUEUED, timestamp, timestamp);
  return getJob(db, id);
}

function getJob(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
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
  db.prepare('UPDATE jobs SET stage = ?, progress = ?, updated_at = ? WHERE id = ?')
    .run(stage, progress, timestamp, id);
}

function heartbeat(db, id) {
  const timestamp = now();
  db.prepare('UPDATE jobs SET last_heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = ?')
    .run(timestamp, timestamp, id, STATUS.RUNNING);
}

function markDone(db, id, title, markdown) {
  const timestamp = now();
  db.prepare(`UPDATE jobs SET status = ?, stage = NULL, progress = 100, title = ?, markdown = ?, error = NULL, last_heartbeat_at = NULL, updated_at = ? WHERE id = ?`)
    .run(STATUS.DONE, title || null, markdown, timestamp, id);
}

function markFailed(db, id, error, stage) {
  const timestamp = now();
  db.prepare(`UPDATE jobs SET status = ?, stage = ?, error = ?, last_heartbeat_at = NULL, updated_at = ? WHERE id = ?`)
    .run(STATUS.FAILED, stage || null, error, timestamp, id);
}

function closeDatabase(db) {
  db.close();
}

module.exports = { openDatabase, createJob, getJob, claimNextJob, reclaimStaleJobs, updateStage, heartbeat, markDone, markFailed, closeDatabase };
