import crypto from 'node:crypto';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import type { Job, JobStatus } from '../../domain/job/entity.ts';
import { normalizeLang } from '../../domain/lang.ts';
import { extractVideoIdFromUrl, validateYouTubeUrl } from '../../domain/youtube/validation.ts';
import { loadConfig } from '../../shared/config.ts';
import { createSqliteJobStore, openDatabase } from '../outbound/sqlite/job-store.ts';

const runtimeConfig = loadConfig(process.env);
const app = express();
const db = openDatabase();
const store = createSqliteJobStore(db);
const publicDir = path.join(import.meta.dirname, 'public');

app.disable('x-powered-by');

// Security headers (todo.md P3, defense in depth — the response markdown is
// already escaped before innerHTML). The UI ships no inline scripts/styles
// (external app.js/style.css only), so a strict CSP is safe: 'self' everywhere.
// No auth here by design: the app is loopback-only and remote exposure goes
// through the operator's reverse proxy, which MUST enforce authentication
// (see README "Access the app remotely").
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// Rate limiting (todo.md P3): fixed window per client IP over the two POST
// endpoints that trigger paid worker stages (summarize, retry) — an exposed
// instance without this lets anyone burn the OpenRouter budget. In-memory,
// single process (the app is one Express process; no shared store needed).
// GETs are unlimited (the UI polls). Behind a reverse proxy, req.ip is the
// proxy's address (no trust-proxy), so remote users share one bucket — that
// still caps the total spend rate, which is the point. Buckets expire with
// their window; a sweep bounds the map.
const rateBuckets = new Map<string, { start: number; count: number }>();
function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const now = Date.now();
  const windowMs = runtimeConfig.rateLimitWindowMs;
  const ip = req.ip ?? 'unknown';
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.start >= windowMs) {
    bucket = { start: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  if (rateBuckets.size > 1024) {
    for (const [key, entry] of rateBuckets) {
      if (now - entry.start >= windowMs) rateBuckets.delete(key);
    }
  }
  bucket.count += 1;
  if (bucket.count > runtimeConfig.rateLimitMax) {
    const retryAfter = Math.max(1, Math.ceil((bucket.start + windowMs - now) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please retry later.' });
    return;
  }
  next();
}

app.use(express.json({ limit: '16kb' }));

interface PublicJob {
  jobId: string;
  status: JobStatus;
  stage: string | null;
  progress: number;
  title: string | null;
  error: string | null;
  lang: string | null;
  createdAt: string;
  updatedAt: string;
}

function publicJob(job: Job | null): PublicJob | null {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    title: job.title,
    error: job.error,
    lang: job.lang,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

interface CreateBody {
  url?: unknown;
  lang?: unknown;
}

app.post('/api/summarize', rateLimit, (req: Request<object, unknown, CreateBody>, res: Response) => {
  const error = validateYouTubeUrl(req.body?.url);
  if (error) return res.status(400).json({ error });
  const lang = normalizeLang(req.body?.lang);
  if (!lang) return res.status(400).json({ error: 'The output language must be a two-letter ISO 639-1 code.' });
  const url = (req.body.url as string).trim();
  const videoId = extractVideoIdFromUrl(url);
  const existing = videoId ? store.findExisting(videoId, lang) : null;
  if (existing) {
    return res.status(200).json({ jobId: existing.id, deduped: true });
  }
  const job = store.create({ id: crypto.randomUUID(), url, videoId, lang });
  return res.status(201).json({ jobId: job?.id });
});

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 50;
const HISTORY_MAX_OFFSET = 10000;
const HISTORY_MAX_SEARCH_LENGTH = 100;

app.get('/api/jobs', (req: Request, res: Response) => {
  const rawLimit = req.query.limit;
  let limit = HISTORY_DEFAULT_LIMIT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) {
      return res.status(400).json({ error: 'The limit must be an integer between 1 and 50.' });
    }
    limit = Number(rawLimit);
    if (limit < 1 || limit > HISTORY_MAX_LIMIT) {
      return res.status(400).json({ error: 'The limit must be an integer between 1 and 50.' });
    }
  }
  const rawSearch = req.query.q;
  if (rawSearch !== undefined && typeof rawSearch !== 'string') {
    return res.status(400).json({ error: 'The search query must be 100 characters or fewer.' });
  }
  const search = typeof rawSearch === 'string' ? rawSearch : undefined;
  if (search !== undefined && search.length > HISTORY_MAX_SEARCH_LENGTH) {
    return res.status(400).json({ error: 'The search query must be 100 characters or fewer.' });
  }
  const rawOffset = req.query.offset;
  let offset = 0;
  if (rawOffset !== undefined) {
    if (typeof rawOffset !== 'string' || !/^\d+$/.test(rawOffset)) {
      return res.status(400).json({ error: 'The offset must be an integer between 0 and 10000.' });
    }
    offset = Number(rawOffset);
    if (offset < 0 || offset > HISTORY_MAX_OFFSET) {
      return res.status(400).json({ error: 'The offset must be an integer between 0 and 10000.' });
    }
  }
  const jobs = store.listDone(limit, search, offset).map(publicJob);
  const total = store.countDone(search);
  return res.json({ jobs, total, limit, offset, hasMore: offset + jobs.length < total });
});

app.get('/api/jobs/:id', (req: Request<{ id: string }>, res: Response) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json(publicJob(job));
});

// Re-queue a failed job. The worker's pipeline resumes from the artifacts
// already on disk (downloaded audio, audio.wav, chunk transcripts,
// transcript.txt), so retrying does not pay again for completed stages.
// 404 unknown, 409 when the job is not failed (queued/running/done).
app.post('/api/jobs/:id/retry', rateLimit, (req: Request<{ id: string }>, res: Response) => {
  const existing = store.get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Job not found.' });
  if (existing.status !== 'failed') return res.status(409).json({ error: 'Only failed jobs can be retried.' });
  // Conditional UPDATE inside store.retryFailed: if the job stopped being
  // failed between the check and the update, this is a no-op (null) → 409.
  const retried = store.retryFailed(req.params.id);
  if (!retried) return res.status(409).json({ error: 'Only failed jobs can be retried.' });
  return res.status(200).json(publicJob(retried));
});

app.get('/api/jobs/:id/result', (req: Request<{ id: string }>, res: Response) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done') return res.status(409).json({ error: job.error || 'This note is not ready yet.' });
  return res.json({
    title: job.title,
    markdown: job.markdown,
    wordCount: (job.markdown ?? '').trim().split(/\s+/).filter(Boolean).length,
  });
});

app.get('/api/jobs/:id/result.md', (req: Request<{ id: string }>, res: Response) => {
  const job = store.get(req.params.id);
  if (!job) return res.status(404).type('text').send('Job not found.');
  if (job.status !== 'done')
    return res
      .status(409)
      .type('text')
      .send(job.error || 'This note is not ready yet.');
  const filename = `${
    (job.title || 'study-note')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'study-note'
  }.md`;
  res.type('text/markdown').set('Content-Disposition', `attachment; filename="${filename}"`).send(job.markdown);
});

app.use(express.static(publicDir, { index: 'index.html' }));
app.use((_req: Request, res: Response) => res.status(404).json({ error: 'Not found.' }));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? error.status
      : typeof error === 'object' && error !== null && 'statusCode' in error
        ? error.statusCode
        : undefined;
  if (status === 413) return res.status(413).json({ error: 'Request body too large.' });
  if (error instanceof SyntaxError && 'body' in error)
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error(error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(runtimeConfig.port, '0.0.0.0', () => {
  console.log(`Summarize YT app listening on http://0.0.0.0:${runtimeConfig.port}`);
});

function shutdown(signal: string): void {
  console.log(`${signal}: shutting down`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
