const fs = require('node:fs');
const path = require('node:path');
const { runProcess, StageError } = require('./process');

async function download(job, context) {
  const output = path.join(context.jobDir, 'audio.%(ext)s');
  const args = [
    '--no-playlist', '--no-warnings', '--no-update', '--print', '%(title)s',
    '-f', 'bestaudio/best', '-o', output,
  ];
  // YouTube bot-checks datacenter IPs; a Netscape-format cookies file (e.g. exported
  // from a logged-in browser) makes downloads reliable on those networks.
  if (fs.existsSync('/secrets/youtube-cookies.txt')) {
    args.push('--cookies', '/secrets/youtube-cookies.txt');
  }
  args.push(job.url);
  const result = await runProcess('yt-dlp', args, { stage: 'downloading', timeoutMs: context.timeoutMs, logPath: context.logPath, onHeartbeat: context.onHeartbeat });
  const audioFile = fs.readdirSync(context.jobDir).find(name => name.startsWith('audio.') && name !== 'audio.wav');
  if (!audioFile) throw new StageError('YouTube audio was not downloaded.', 'downloading');
  const lines = result.stdout.trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const title = lines.at(-1) || 'Untitled YouTube video';
  return { audioPath: path.join(context.jobDir, audioFile), title: title.slice(0, 500) };
}

module.exports = { download };
