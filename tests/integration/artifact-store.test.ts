/**
 * Integration tests for the filesystem ArtifactStore adapter (phase 2A).
 * Covers the bounded probes, the resume priority, cached-title rules and
 * the selective cleanup.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { createFilesystemArtifactStore } from '../../src/worker/artifacts.ts';

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {}
  }
  root = undefined;
});

function writeWav(dir: string): string {
  const file = path.join(dir, 'audio.wav');
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.write('WAVE', 8, 'ascii');
  fs.writeFileSync(file, Buffer.concat([header, Buffer.alloc(200)]));
  return file;
}

describe('ArtifactStore (filesystem adapter)', () => {
  it('ensureJobDir creates the directory and pathsFor describes the conventions', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('job1');
    assert.equal(dir, path.join(root, 'job1'));
    assert.ok(fs.statSync(dir).isDirectory());
    const paths = store.pathsFor('job1');
    assert.equal(paths.transcriptPath, path.join(root, 'job1', 'transcript.txt'));
    assert.equal(paths.wavPath, path.join(root, 'job1', 'audio.wav'));
    assert.equal(paths.summaryPath, path.join(root, 'job1', 'summary.md'));
    assert.equal(paths.logPath, path.join(root, 'job1', 'stage.log'));
  });

  it('probe resumes at summarizing when a non-blank transcript exists', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('t1');
    fs.writeFileSync(path.join(dir, 'transcript.txt'), ' hello transcript ');
    writeWav(dir);
    fs.writeFileSync(path.join(dir, 'audio.m4a'), 'x');
    const probe = store.probe('t1');
    assert.equal(probe.hasTranscript, true);
    assert.equal(probe.hasWav, false); // short-circuit: transcript short-circuits the wav probe
    assert.equal(probe.hasDownloadedAudio, false);
    assert.equal(probe.resume, 'summarizing');
    assert.equal(probe.downloadedAudioPath, null);
  });

  it('probe resumes at transcribing for a valid RIFF/WAVE wav, ignoring downloads', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('w1');
    writeWav(dir);
    fs.writeFileSync(path.join(dir, 'audio.m4a'), 'x');
    const probe = store.probe('w1');
    assert.equal(probe.hasTranscript, false);
    assert.equal(probe.hasWav, true);
    assert.equal(probe.resume, 'transcribing');
  });

  it('probe ignores a too-small or non-RIFF header-only wav', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('tiny');
    fs.writeFileSync(path.join(dir, 'audio.wav'), Buffer.alloc(20));
    let probe = store.probe('tiny');
    assert.equal(probe.hasWav, false);
    assert.equal(probe.resume, null);
    const bad = Buffer.alloc(100);
    fs.writeFileSync(path.join(dir, 'audio.wav'), bad);
    probe = store.probe('tiny');
    assert.equal(probe.hasWav, false);
    assert.equal(probe.resume, null);
  });

  it('probe resumes at converting only for a non-empty downloaded audio', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('c1');
    fs.writeFileSync(path.join(dir, 'audio.m4a'), '');
    let probe = store.probe('c1');
    assert.equal(probe.hasDownloadedAudio, false);
    assert.equal(probe.resume, null);
    fs.writeFileSync(path.join(dir, 'audio.m4a'), 'data');
    probe = store.probe('c1');
    assert.equal(probe.hasDownloadedAudio, true);
    assert.equal(probe.resume, 'converting');
    assert.equal(probe.downloadedAudioPath, path.join(dir, 'audio.m4a'));
  });

  it('writeSummary appends the trailing newline; readCachedTitle takes the last line, capped at 500', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('s1');
    const summary = store.writeSummary('s1', '# Note');
    assert.equal(summary, path.join(dir, 'summary.md'));
    assert.equal(fs.readFileSync(summary, 'utf8'), '# Note\n');
    fs.writeFileSync(path.join(dir, '.title'), 'first\n  last line  \n');
    assert.equal(store.readCachedTitle('s1'), 'last line');
    fs.writeFileSync(path.join(dir, '.title'), `${'x'.repeat(600)}\n`);
    const capped = store.readCachedTitle('s1');
    assert.equal(capped?.length, 500);
  });

  it('cleanup removes only the requested partials and keeps the wav/summary', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-store-'));
    const store = createFilesystemArtifactStore(root);
    const dir = store.ensureJobDir('d1');
    store.writeSummary('d1', '# Note');
    writeWav(dir);
    fs.writeFileSync(path.join(dir, 'audio.m4a'), 'x');
    fs.writeFileSync(path.join(dir, '.title'), 't');
    store.removeDownloadedAudio('d1');
    assert.ok(!fs.existsSync(path.join(dir, 'audio.m4a')));
    assert.ok(fs.existsSync(path.join(dir, 'audio.wav')));
    store.removeTitle('d1');
    assert.ok(!fs.existsSync(path.join(dir, '.title')));
    store.removeFile(path.join(dir, 'summary.md'));
    assert.ok(!fs.existsSync(path.join(dir, 'summary.md')));
    store.removeFile(undefined);
    store.removeWav('d1');
    assert.ok(!fs.existsSync(path.join(dir, 'audio.wav')));
  });
});
