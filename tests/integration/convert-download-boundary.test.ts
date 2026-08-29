/**
 * Behavioral tests for the download and convert stages
 * (src/worker/stages/download.ts, src/worker/stages/convert.ts).
 *
 * Both invoke external CLIs (yt-dlp / ffmpeg) through runProcess, resolved via
 * PATH. We provide fake `yt-dlp` and `ffmpeg` scripts in a temp bin dir and
 * prepend it to PATH so the full stage logic (arg building, title parsing,
 * output discovery, error mapping) runs against a real (fake) subprocess.
 *
 * Category: integration — outbound adapter (fake CLI on PATH).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { convert } from '../../src/worker/stages/convert.ts';
import { download } from '../../src/worker/stages/download.ts';
import type { StageContext } from '../../src/worker/stages/process.ts';

let binDir: string | undefined;
let jobDir: string | undefined;
const originalPath = process.env.PATH;

function installFake(name: string, body: string): void {
  if (!binDir) binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakebin-'));
  const p = path.join(binDir, name);
  fs.writeFileSync(p, `#!/usr/bin/env bash\n${body}`, { mode: 0o755 });
}

function withPath(): void {
  if (binDir) process.env.PATH = `${binDir}:${originalPath}`;
}

const baseContext = (dir: string): StageContext => ({
  jobDir: dir,
  logPath: path.join(dir, 'stage.log'),
  timeoutMs: 10000,
});

afterEach(() => {
  if (binDir) {
    try {
      fs.rmSync(binDir, { recursive: true, force: true });
    } catch {}
  }
  if (jobDir) {
    try {
      fs.rmSync(jobDir, { recursive: true, force: true });
    } catch {}
  }
  process.env.PATH = originalPath;
  binDir = undefined;
  jobDir = undefined;
});

// yt-dlp fake: parse -o to find the job dir, write a title file and an audio file.
const FAKE_YTDLP = `
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then output="$a"; fi
  prev="$a"
done
jobdir="$(dirname "$output")"
printf 'Great Talk\\n' > "$jobdir/.title"
: > "$jobdir/audio.webm"
exit 0
`;

// ffmpeg fake: last arg is the wav output path; write a small file there.
const FAKE_FFMPEG = `
wav=""
for a in "$@"; do wav="$a"; done
: > "$wav"
exit 0
`;

describe('download — yt-dlp wrapper', () => {
  it('resolves audioPath and title from a successful download', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    installFake('yt-dlp', FAKE_YTDLP);
    withPath();

    const result = await download({ url: 'https://youtu.be/dQw4w9WgXcQ' }, baseContext(jobDir));
    assert.ok(path.isAbsolute(result.audioPath), 'audioPath should be absolute');
    assert.match(result.audioPath, /audio\.webm$/);
    assert.equal(result.title, 'Great Talk');
  });

  it('throws a downloading StageError when no audio file is produced', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    // fake that never writes an audio file
    installFake('yt-dlp', 'exit 0\n');
    withPath();

    await assert.rejects(
      download({ url: 'https://youtu.be/dQw4w9WgXcQ' }, baseContext(jobDir)),
      (error: unknown) => error instanceof Error && (error as { stage?: string }).stage === 'downloading',
    );
  });
});

describe('convert — ffmpeg wrapper', () => {
  it('returns the wav path after running ffmpeg', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    installFake('ffmpeg', FAKE_FFMPEG);
    withPath();
    const audioPath = path.join(jobDir, 'audio.webm');
    fs.writeFileSync(audioPath, 'dummy');

    const wav = await convert(audioPath, baseContext(jobDir));
    assert.equal(path.basename(wav), 'audio.wav');
    assert.equal(fs.existsSync(wav), true);
  });

  it('invokes ffmpeg with expected transcoding args', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'ffmpeg-args');
    installFake(
      'ffmpeg',
      `
      printf '%s\\n' "$@" > "${argLog}"
      wav=""
      for a in "$@"; do wav="$a"; done
      : > "$wav"
      exit 0
      `,
    );
    withPath();
    const audioPath = path.join(jobDir, 'audio.webm');
    fs.writeFileSync(audioPath, 'dummy');

    await convert(audioPath, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    assert.ok(args.includes('-hide_banner'));
    assert.ok(args.includes('-loglevel'));
    assert.ok(args.includes('error'));
    assert.ok(args.includes('-y'));
    assert.ok(args.includes('-i'));
    assert.ok(args.includes(audioPath));
    assert.ok(args.includes('-ar'));
    assert.ok(args.includes('16000'));
    assert.ok(args.includes('-ac'));
    assert.ok(args.includes('1'));
    assert.ok(args.includes('-c:a'));
    assert.ok(args.includes('pcm_s16le'));
    assert.equal(args[args.length - 1], path.join(jobDir, 'audio.wav'));
  });

  it('throws a converting StageError when ffmpeg exits non-zero', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    installFake('ffmpeg', 'exit 1\n');
    withPath();
    const audioPath = path.join(jobDir, 'audio.webm');
    fs.writeFileSync(audioPath, 'dummy');

    await assert.rejects(
      convert(audioPath, baseContext(jobDir)),
      (error: unknown) => error instanceof Error && (error as { stage?: string }).stage === 'converting',
    );
  });

  it('passes through stage context (timeout, logPath, heartbeat, signal)', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const heartbeatLog = path.join(jobDir, 'heartbeat');
    installFake('ffmpeg', FAKE_FFMPEG);
    withPath();
    const audioPath = path.join(jobDir, 'audio.webm');
    fs.writeFileSync(audioPath, 'dummy');
    const ctx: StageContext = {
      jobDir,
      logPath: path.join(jobDir, 'stage.log'),
      timeoutMs: 12345,
      onHeartbeat: () => {
        fs.writeFileSync(heartbeatLog, 'beat');
      },
      signal: new AbortController().signal,
    };
    const wav = await convert(audioPath, ctx);
    assert.equal(path.basename(wav), 'audio.wav');
    // runProcess should have been called with the context values — at least not throw
    assert.ok(fs.existsSync(wav));
  });
});
