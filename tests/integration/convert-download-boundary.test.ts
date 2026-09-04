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
import { afterEach, describe, it, mock } from 'node:test';
import { convert } from '../../src/worker/stages/convert.ts';
import { download } from '../../src/worker/stages/download.ts';
import type { StageContext } from '../../src/worker/stages/process.ts';
import { StageError } from '../../src/worker/stages/process.ts';

let binDir: string | undefined;
let jobDir: string | undefined;
const originalPath = process.env.PATH;
const originalMullvadEnabled = process.env.MULLVAD_ENABLED;
const originalMullvadProxy = process.env.MULLVAD_PROXY;
const origExistsSync = fs.existsSync;
const origStatSync = fs.statSync;
const origReadFileSync = fs.readFileSync;

function stubYouTubeCookies(valid: boolean): void {
  const validContent = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t0\tSID\tvalue\n';
  const files = valid
    ? new Map<string, string>([['/run/secrets/youtube_cookies', validContent]])
    : new Map<string, string>();
  mock.method(fs, 'existsSync', (p: fs.PathLike) => {
    const s = p.toString();
    if (s === '/run/secrets/youtube_cookies') return files.has(s);
    return origExistsSync(s);
  });
  mock.method(fs, 'statSync', ((p: fs.PathLike) => {
    const s = p.toString();
    if (files.has(s)) return { size: (files.get(s) ?? '').length } as fs.Stats;
    if (s === '/run/secrets/youtube_cookies') {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }
    return origStatSync(p);
  }) as typeof fs.statSync);
  mock.method(fs, 'readFileSync', ((p: fs.PathLike, ...args: unknown[]) => {
    const s = p.toString();
    if (files.has(s)) return files.get(s) as unknown as string;
    return (origReadFileSync as unknown as (...a: unknown[]) => unknown)(p, ...args);
  }) as typeof fs.readFileSync);
}

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
  mock.restoreAll();
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
  if (originalMullvadEnabled === undefined) delete process.env.MULLVAD_ENABLED;
  else process.env.MULLVAD_ENABLED = originalMullvadEnabled;
  if (originalMullvadProxy === undefined) delete process.env.MULLVAD_PROXY;
  else process.env.MULLVAD_PROXY = originalMullvadProxy;
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

    await assert.rejects(download({ url: 'https://youtu.be/dQw4w9WgXcQ' }, baseContext(jobDir)), (error: unknown) => {
      assert.ok(error instanceof StageError);
      assert.equal((error as StageError).stage, 'downloading');
      assert.equal((error as StageError).message, 'YouTube audio was not downloaded.');
      return true;
    });
  });

  it('invokes yt-dlp with expected args', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'yt-args');
    const url = 'https://youtu.be/dQw4w9WgXcQ';
    const expectedOutput = path.join(jobDir, 'audio.%(ext)s');
    const expectedTitlePath = path.join(jobDir, '.title');
    installFake(
      'yt-dlp',
      `
      printf '%s\\n' "$@" > "${argLog}"
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Great Talk\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();

    await download({ url }, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    assert.ok(args.includes('--no-playlist'));
    assert.ok(args.includes('--no-warnings'));
    assert.ok(args.includes('--no-update'));
    assert.ok(args.includes('--print-to-file'));
    assert.ok(args.includes('%(title)s'));
    assert.ok(args.includes(expectedTitlePath));
    assert.ok(args.includes('-f'));
    assert.ok(args.includes('bestaudio/best'));
    assert.ok(args.includes('-o'));
    assert.ok(args.includes(expectedOutput));
    assert.equal(args[args.length - 1], url);
  });

  it('routes yt-dlp through the default Mullvad proxy when MULLVAD_ENABLED=true', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'yt-args');
    process.env.MULLVAD_ENABLED = 'true';
    delete process.env.MULLVAD_PROXY;
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      printf '%s\\n' "$@" > "${argLog}"
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Title\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    const proxyIdx = args.indexOf('--proxy');
    assert.ok(proxyIdx !== -1, 'should include --proxy');
    assert.equal(args[proxyIdx + 1], 'socks5h://127.0.0.1:1080');
  });

  it('uses custom MULLVAD_PROXY when set', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'yt-args');
    process.env.MULLVAD_ENABLED = 'true';
    process.env.MULLVAD_PROXY = 'socks5h://custom:1080';
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      printf '%s\\n' "$@" > "${argLog}"
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Title\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    assert.ok(args.includes('--proxy'));
    assert.ok(args.includes('socks5h://custom:1080'));
  });

  it('omits --proxy when MULLVAD_ENABLED is not "true"', async () => {
    for (const val of [undefined, 'false', '1', '']) {
      jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
      const argLog = path.join(jobDir, 'yt-args');
      if (val === undefined) delete process.env.MULLVAD_ENABLED;
      else process.env.MULLVAD_ENABLED = val;
      delete process.env.MULLVAD_PROXY;
      stubYouTubeCookies(false);
      installFake(
        'yt-dlp',
        `
        printf '%s\\n' "$@" > "${argLog}"
        prev=""
        for a in "$@"; do
          if [ "$prev" = "-o" ]; then output="$a"; fi
          prev="$a"
        done
        jobdir="$(dirname "$output")"
        printf 'Title\\n' > "$jobdir/.title"
        : > "$jobdir/audio.webm"
        exit 0
        `,
      );
      withPath();
      await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
      const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
      assert.ok(!args.includes('--proxy'), `should not include --proxy when MULLVAD_ENABLED=${String(val)}`);
      assert.ok(!args.includes('socks5h://127.0.0.1:1080'));
      fs.rmSync(jobDir, { recursive: true, force: true });
      jobDir = undefined;
      // reset fake bin for next iteration
      if (binDir) {
        fs.rmSync(binDir, { recursive: true, force: true });
        binDir = undefined;
      }
      mock.restoreAll();
    }
  });

  it('includes --cookies when a valid cookies file exists', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'yt-args');
    delete process.env.MULLVAD_ENABLED;
    delete process.env.MULLVAD_PROXY;
    stubYouTubeCookies(true);
    installFake(
      'yt-dlp',
      `
      printf '%s\\n' "$@" > "${argLog}"
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Title\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    const idx = args.indexOf('--cookies');
    assert.ok(idx !== -1, 'should include --cookies');
    assert.equal(args[idx + 1], '/run/secrets/youtube_cookies');
  });

  it('omits --cookies when no valid cookies file exists', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    const argLog = path.join(jobDir, 'yt-args');
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      printf '%s\\n' "$@" > "${argLog}"
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Title\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    const args = fs.readFileSync(argLog, 'utf8').split('\n').filter(Boolean);
    assert.ok(!args.includes('--cookies'));
  });

  it('rejects with downloading StageError when yt-dlp exits non-zero', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake('yt-dlp', 'echo "yt-dlp error" >&2; exit 1\n');
    withPath();
    await assert.rejects(download({ url: 'https://youtu.be/abc' }, baseContext(jobDir)), (error: unknown) => {
      assert.ok(error instanceof StageError);
      assert.equal((error as StageError).stage, 'downloading');
      assert.match((error as StageError).message, /exit code 1/);
      return true;
    });
  });

  it('propagates timeoutMs to runProcess', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake('yt-dlp', 'sleep 2\n');
    withPath();
    await assert.rejects(
      download({ url: 'https://youtu.be/abc' }, { ...baseContext(jobDir), timeoutMs: 300 }),
      (error: unknown) => {
        assert.ok(error instanceof StageError);
        assert.equal((error as StageError).stage, 'downloading');
        assert.match((error as StageError).message, /timed out/);
        return true;
      },
    );
  });

  it('propagates abort signal to runProcess', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake('yt-dlp', FAKE_YTDLP);
    withPath();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(
      download({ url: 'https://youtu.be/abc' }, { ...baseContext(jobDir), signal: ac.signal }),
      (error: unknown) => {
        assert.ok(error instanceof StageError);
        assert.equal((error as StageError).stage, 'downloading');
        assert.match((error as StageError).message, /cancelled/);
        return true;
      },
    );
  });

  it('discovers audio file ignoring audio.wav and unrelated files', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    // pre-create decoys that should be ignored
    fs.writeFileSync(path.join(jobDir, 'audio.wav'), 'wav');
    fs.writeFileSync(path.join(jobDir, 'random.txt'), 'noise');
    installFake(
      'yt-dlp',
      `
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'Title\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    // control readdir order to make the test deterministic: wav appears before webm
    const origReaddirSync = fs.readdirSync;
    mock.method(fs, 'readdirSync', (p: fs.PathLike) => {
      if (p.toString() === jobDir)
        return ['audio.wav', 'random.txt', 'audio.webm', '.title'] as unknown as ReturnType<typeof fs.readdirSync>;
      return origReaddirSync(p as string) as unknown as ReturnType<typeof fs.readdirSync>;
    });
    const result = await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    assert.match(result.audioPath, /audio\.webm$/);
    assert.ok(!result.audioPath.endsWith('audio.wav'), 'should not pick audio.wav');
    assert.ok(fs.existsSync(result.audioPath));
  });

  it('returns Untitled when title file is missing', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    const result = await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    assert.equal(result.title, 'Untitled YouTube video');
  });

  it('parses title trimming, splitting CRLF and taking last line', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf '  first line  \\r\\nsecond line\\nTrimMe  \\r\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    const result = await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    assert.equal(result.title, 'TrimMe');
  });

  it('parses title with LF-only lines correctly (kills \\r\\n mutant)', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    installFake(
      'yt-dlp',
      `
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf 'first\\nsecond\\nlast\\n' > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    const result = await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    assert.equal(result.title, 'last');
  });

  it('truncates title to 500 characters', async () => {
    jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
    delete process.env.MULLVAD_ENABLED;
    stubYouTubeCookies(false);
    const longTitle = 'a'.repeat(600);
    installFake(
      'yt-dlp',
      `
      prev=""
      for a in "$@"; do
        if [ "$prev" = "-o" ]; then output="$a"; fi
        prev="$a"
      done
      jobdir="$(dirname "$output")"
      printf '%s' "${longTitle}" > "$jobdir/.title"
      : > "$jobdir/audio.webm"
      exit 0
      `,
    );
    withPath();
    const result = await download({ url: 'https://youtu.be/abc' }, baseContext(jobDir));
    assert.equal(result.title.length, 500);
    assert.equal(result.title, 'a'.repeat(500));
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
