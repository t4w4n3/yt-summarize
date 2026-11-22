/**
 * Canonical YouTube URL validation and video-id extraction.
 *
 * Single owner of the YouTube host/path rules (moved here from app/server.ts
 * and shared/db.ts, which duplicated them). Adapters delegate; the domain
 * decides. Later ports (phase 2+) build on the same single source.
 */

const ALLOWED_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'www.youtu.be',
  'youtu.be',
  'www.youtube-nocookie.com',
]);

const SHORT_HOSTS = new Set(['youtu.be', 'www.youtu.be']);

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function readShortId(pathname: string): string | null {
  const raw = pathname.slice(1).split('/')[0] ?? '';
  const id = (raw.split('?')[0] ?? '').split('#')[0] ?? '';
  return id === '' ? null : id;
}

function readLongId(url: URL): string | null {
  if (url.pathname === '/watch') return url.searchParams.get('v');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length >= 2 && ['shorts', 'embed', 'v', 'live'].includes(parts[0] ?? '')) {
    return parts[1] ?? null;
  }
  return null;
}

/**
 * HTTP-facing validation. Returns an error message, or null when the URL is
 * accepted. This is the exact gate the `POST /api/summarize` endpoint
 * applies before anything is persisted or enqueued.
 */
export function validateYouTubeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return 'Enter a YouTube video URL.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'Enter a valid YouTube video URL.';
  }
  const hostname = url.hostname.toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || !ALLOWED_HOSTS.has(hostname)) {
    return 'Only youtube.com and youtu.be video URLs are supported.';
  }
  if (url.username || url.password || url.port) return 'This URL contains unsupported credentials or a port.';
  const id = SHORT_HOSTS.has(hostname) ? readShortId(url.pathname) : readLongId(url);
  if (id === null && !SHORT_HOSTS.has(hostname)) return 'Use a standard YouTube watch URL or a youtu.be link.';
  if (!id || !VIDEO_ID.test(id)) return 'That URL does not contain a valid single YouTube video ID.';
  return null;
}

export function extractVideoIdFromUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase();
  if (!ALLOWED_HOSTS.has(hostname)) return null;
  const id = SHORT_HOSTS.has(hostname) ? readShortId(url.pathname) : readLongId(url);
  return id && VIDEO_ID.test(id) ? id : null;
}
