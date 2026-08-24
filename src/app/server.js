const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { config } = require('../shared/constants');
const { openDatabase, createJob, getJob, findExistingJobByVideoId } = require('../shared/db');

const app = express();
const db = openDatabase();
const publicDir = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function extractVideoId(value) {
  try {
    const url = new URL(value.trim());
    const hostname = url.hostname.toLowerCase();
    const isShort = hostname.endsWith('youtu.be');
    const id = isShort ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
    if (id && /^[A-Za-z0-9_-]{11}$/.test(id)) return id;
  } catch {}
  return null;
}

function validateYouTubeUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return 'Enter a YouTube video URL.';
  let url;
  try { url = new URL(value); } catch { return 'Enter a valid YouTube video URL.'; }
  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtu.be']);
  if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(hostname)) return 'Only youtube.com and youtu.be video URLs are supported.';
  if (url.username || url.password || url.port) return 'This URL contains unsupported credentials or a port.';
  const isShort = hostname.endsWith('youtu.be');
  const id = isShort ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return 'That URL does not contain a valid single YouTube video ID.';
  if (!isShort && url.pathname !== '/watch') return 'Use a standard YouTube watch URL or a youtu.be link.';
  return null;
}

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    title: job.title,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}

app.post('/api/summarize', (req, res) => {
  const error = validateYouTubeUrl(req.body?.url);
  if (error) return res.status(400).json({ error });
  const url = req.body.url.trim();
  const videoId = extractVideoId(url);
  const existing = videoId ? findExistingJobByVideoId(db, videoId) : null;
  if (existing) {
    return res.status(200).json({ jobId: existing.id, deduped: true });
  }
  const job = createJob(db, crypto.randomUUID(), url, videoId);
  return res.status(201).json({ jobId: job.id });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json(publicJob(job));
});

app.get('/api/jobs/:id/result', (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done') return res.status(409).json({ error: job.error || 'This note is not ready yet.' });
  return res.json({ title: job.title, markdown: job.markdown, wordCount: job.markdown.trim().split(/\s+/).filter(Boolean).length });
});

app.get('/api/jobs/:id/result.md', (req, res) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).type('text').send('Job not found.');
  if (job.status !== 'done') return res.status(409).type('text').send(job.error || 'This note is not ready yet.');
  const filename = `${(job.title || 'study-note').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80) || 'study-note'}.md`;
  res.type('text/markdown').set('Content-Disposition', `attachment; filename="${filename}"`).send(job.markdown);
});

app.use(express.static(publicDir, { index: 'index.html' }));
app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use((error, req, res, next) => {
  if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error(error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Summarize YT app listening on http://0.0.0.0:${config.port}`);
});

function shutdown(signal) {
  console.log(`${signal}: shutting down`);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
