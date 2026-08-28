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
});
