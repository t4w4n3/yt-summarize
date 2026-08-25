import fs from 'node:fs';
import path from 'node:path';
import type { StageContext } from './process.ts';
import { runProcess, StageError } from './process.ts';

export interface DownloadResult {
  audioPath: string;
  title: string;
}

export async function download(job: { url: string }, context: StageContext): Promise<DownloadResult> {
  const output = path.join(context.jobDir, 'audio.%(ext)s');
  const titlePath = path.join(context.jobDir, '.title');
  const args = [
    // --print implique --simulate (aucun téléchargement) dans yt-dlp ≥2025 —
    // on écrit donc le titre dans un fichier via --print-to-file.
    '--no-playlist',
    '--no-warnings',
    '--no-update',
    '--print-to-file',
    '%(title)s',
    titlePath,
    '-f',
    'bestaudio/best',
    '-o',
    output,
  ];
  // Mullvad sidecar (service `vpn` du compose): yt-dlp passe par le proxy
  // SOCKS5 du sidecar → tunnel Mullvad. Seul ce trafic sort par le VPN.
  // socks5h = résolution DNS par le proxy (DNS aussi via le tunnel).
  if (process.env.MULLVAD_ENABLED === 'true') {
    args.push('--proxy', process.env.MULLVAD_PROXY || 'socks5h://127.0.0.1:1080');
  }
  // YouTube bot-checks datacenter IPs; a Netscape-format cookies file (e.g. exported
  // from a logged-in browser) makes downloads reliable on those networks.
  // Preferred: podman secret at /run/secrets/youtube_cookies (rootless-friendly).
  // Fallback: legacy bind mount at /secrets/youtube-cookies.txt.
  const cookiesSecret = '/run/secrets/youtube_cookies';
  const cookiesLegacy = '/secrets/youtube-cookies.txt';
  let cookiesPath: string | null = null;
  if (fs.existsSync(cookiesSecret)) {
    try {
      const stat = fs.statSync(cookiesSecret);
      if (stat.size > 0) {
        const content = fs.readFileSync(cookiesSecret, 'utf8');
        // dummy placeholder from sync script is "# empty" or sk-or-missing; skip
        if (content.trim() && !content.includes('sk-or-missing') && content.includes('Netscape')) {
          cookiesPath = cookiesSecret;
        } else if (content.trim().length > 20) {
          // any non-empty non-placeholder is treated as cookies
          cookiesPath = cookiesSecret;
        }
      }
    } catch {}
  }
  if (!cookiesPath && fs.existsSync(cookiesLegacy)) {
    cookiesPath = cookiesLegacy;
  }
  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
  }
  args.push(job.url);
  await runProcess('yt-dlp', args, {
    stage: 'downloading',
    timeoutMs: context.timeoutMs,
    logPath: context.logPath,
    onHeartbeat: context.onHeartbeat,
    signal: context.signal,
  });
  const audioFile = fs.readdirSync(context.jobDir).find((name) => name.startsWith('audio.') && name !== 'audio.wav');
  if (!audioFile) throw new StageError('YouTube audio was not downloaded.', 'downloading');
  let title = 'Untitled YouTube video';
  try {
    title = fs.readFileSync(titlePath, 'utf8').trim().split(/\r?\n/).at(-1) || title;
  } catch {}
  return { audioPath: path.join(context.jobDir, audioFile), title: title.slice(0, 500) };
}
