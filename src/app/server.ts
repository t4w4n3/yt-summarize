import crypto from 'node:crypto';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import express from 'express';
import { config } from '../shared/constants.ts';
import type { JobRow } from '../shared/db.ts';
import { createJob, extractVideoIdFromUrl, findExistingJobByVideoId, getJob, openDatabase } from '../shared/db.ts';

const app = express();
const db = openDatabase();
const publicDir = path.join(import.meta.dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '16kb' }));

function validateYouTubeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return 'Enter a YouTube video URL.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a valid YouTube video URL.';
  }
  const hostname = url.hostname.toLowerCase();
  const allowedHosts = new Set([
    'youtube.com',
    'www.youtube.com',
    'm.youtube.com',
    'music.youtube.com',
    'youtu.be',
    'www.youtu.be',
  ]);
  if (!['http:', 'https:'].includes(url.protocol) || !allowedHosts.has(hostname))
    return 'Only youtube.com and youtu.be video URLs are supported.';
  if (url.username || url.password || url.port) return 'This URL contains unsupported credentials or a port.';
  const isShort = hostname.endsWith('youtu.be');
  const id = isShort ? url.pathname.slice(1).split('/')[0] : url.searchParams.get('v');
  if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) return 'That URL does not contain a valid single YouTube video ID.';
  if (!isShort && url.pathname !== '/watch') return 'Use a standard YouTube watch URL or a youtu.be link.';
  return null;
}

interface PublicJob {
  jobId: string;
  status: JobRow['status'];
  stage: string | null;
  progress: number;
  title: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

function publicJob(job: JobRow | null): PublicJob | null {
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

interface CreateBody {
  url?: unknown;
  lang?: unknown;
}

/** Normalize the optional ISO 639-1 output language; null when invalid. */
function normalizeLang(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return 'en';
  if (typeof value !== 'string') return null;
  const code = value.trim().toLowerCase();
  return /^[a-z]{2}$/.test(code) ? code : null;
}

app.post('/api/summarize', (req: Request<object, unknown, CreateBody>, res: Response) => {
  const error = validateYouTubeUrl(req.body?.url);
  if (error) return res.status(400).json({ error });
  const lang = normalizeLang(req.body?.lang);
  if (!lang) return res.status(400).json({ error: 'The output language must be a two-letter ISO 639-1 code.' });
  const url = (req.body.url as string).trim();
  const videoId = extractVideoIdFromUrl(url);
  const existing = videoId ? findExistingJobByVideoId(db, videoId, lang) : null;
  if (existing) {
    return res.status(200).json({ jobId: existing.id, deduped: true });
  }
  const job = createJob(db, crypto.randomUUID(), url, videoId, lang);
  return res.status(201).json({ jobId: job?.id });
});

app.get('/api/jobs/:id', (req: Request<{ id: string }>, res: Response) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  return res.json(publicJob(job));
});

app.get('/api/jobs/:id/result', (req: Request<{ id: string }>, res: Response) => {
  const job = getJob(db, req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status !== 'done') return res.status(409).json({ error: job.error || 'This note is not ready yet.' });
  return res.json({
    title: job.title,
    markdown: job.markdown,
    wordCount: (job.markdown ?? '').trim().split(/\s+/).filter(Boolean).length,
  });
});

app.get('/api/jobs/:id/result.md', (req: Request<{ id: string }>, res: Response) => {
  const job = getJob(db, req.params.id);
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
  if (error instanceof SyntaxError && 'body' in error)
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  console.error(error);
  return res.status(500).json({ error: 'Unexpected server error.' });
});

const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Summarize YT app listening on http://0.0.0.0:${config.port}`);
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
