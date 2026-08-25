/**
 * Unit tests — domain transcription policy.
 *
 * Category: unit — pure domain use cases with no outbound adapters.
 * The policy owns the API-limit decisions (multipart vs base64 vs chunking),
 * error classification, and presentation concerns (joining parts). Every case
 * uses independently derived literal expectations — no recomputation via the
 * production code.
 *
 * Run: pnpm run test:unit
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  alignedChunkBytes,
  CHUNK_DURATION_SEC,
  chooseInitialStrategy,
  fitsMultipart,
  isBase64LimitError,
  isMultipartLimitError,
  joinTranscriptParts,
  MULTIPART_LIMIT,
  nextAfterBase64Failure,
  nextAfterMultipartFailure,
} from '../../src/domain/transcription/policy.ts';

describe('domain/transcription/policy — constants', () => {
  it('MULTIPART_LIMIT is 24 MiB', () => {
    assert.equal(MULTIPART_LIMIT, 24 * 1024 * 1024);
    assert.equal(MULTIPART_LIMIT, 25_165_824);
  });

  it('CHUNK_DURATION_SEC is 10 minutes', () => {
    assert.equal(CHUNK_DURATION_SEC, 600);
  });
});

describe('domain/transcription/policy — fitsMultipart', () => {
  it('small file fits', () => {
    assert.equal(fitsMultipart(0), true);
    assert.equal(fitsMultipart(1), true);
    assert.equal(fitsMultipart(MULTIPART_LIMIT), true);
  });

  it('large file does not fit', () => {
    assert.equal(fitsMultipart(MULTIPART_LIMIT + 1), false);
    assert.equal(fitsMultipart(MULTIPART_LIMIT + 5 * 1024 * 1024), false);
  });
});

describe('domain/transcription/policy — error classification', () => {
  it('isMultipartLimitError detects 413 / 25 MB / input_audio', () => {
    assert.equal(isMultipartLimitError('HTTP 413'), true);
    assert.equal(isMultipartLimitError('Multipart body exceeds the 25 MB upload limit'), true);
    assert.equal(isMultipartLimitError('Send larger files as base64 JSON via input_audio.'), true);
    assert.equal(isMultipartLimitError('error 413 input_audio 25 MB'), true);
  });

  it('isMultipartLimitError rejects unrelated messages', () => {
    assert.equal(isMultipartLimitError('network timeout'), false);
    assert.equal(isMultipartLimitError('Transcription failed (HTTP 500).'), false);
    assert.equal(isMultipartLimitError(''), false);
  });

  it('isBase64LimitError detects 413 / 25 MB but NOT input_audio', () => {
    assert.equal(isBase64LimitError('HTTP 413'), true);
    assert.equal(isBase64LimitError('Multipart body exceeds the 25 MB upload limit'), true);
    // input_audio hint is specific to the multipart path — base64 already uses input_audio
    assert.equal(isBase64LimitError('Send larger files as base64 JSON via input_audio.'), false);
    assert.equal(isBase64LimitError('hint: try input_audio'), false);
  });

  it('isBase64LimitError rejects unrelated messages', () => {
    assert.equal(isBase64LimitError('network timeout'), false);
    assert.equal(isBase64LimitError(''), false);
  });
});

describe('domain/transcription/policy — strategy planner', () => {
  it('chooseInitialStrategy: small → multipart, large → base64, boundary → multipart', () => {
    assert.equal(chooseInitialStrategy(0), 'multipart');
    assert.equal(chooseInitialStrategy(1024), 'multipart');
    assert.equal(chooseInitialStrategy(MULTIPART_LIMIT), 'multipart');
    assert.equal(chooseInitialStrategy(MULTIPART_LIMIT + 1), 'base64');
    assert.equal(chooseInitialStrategy(MULTIPART_LIMIT + 10 * 1024 * 1024), 'base64');
  });

  it('nextAfterMultipartFailure: size-limit error → base64, other errors → null', () => {
    assert.equal(nextAfterMultipartFailure('HTTP 413'), 'base64');
    assert.equal(nextAfterMultipartFailure('Multipart body exceeds the 25 MB upload limit'), 'base64');
    assert.equal(
      nextAfterMultipartFailure(
        'Multipart body exceeds the 25 MB upload limit. Send larger files as base64 JSON via input_audio.',
      ),
      'base64',
    );
    assert.equal(nextAfterMultipartFailure('network timeout'), null);
    assert.equal(nextAfterMultipartFailure('HTTP 500'), null);
    assert.equal(nextAfterMultipartFailure('Transcription failed (HTTP 429).'), null);
  });

  it('nextAfterBase64Failure: large file always → chunk even without limit marker', () => {
    // 413-classified OR any error when file was already large — same as production:
    // `if (!is413 && statSize <= LIMIT) throw` ≡ fallback iff is413 || isLarge
    assert.equal(nextAfterBase64Failure('HTTP 500', MULTIPART_LIMIT + 1), 'chunk');
    assert.equal(nextAfterBase64Failure('network timeout', MULTIPART_LIMIT + 100), 'chunk');
    assert.equal(nextAfterBase64Failure('Transcription failed (HTTP 429).', MULTIPART_LIMIT + 1), 'chunk');
  });

  it('nextAfterBase64Failure: small file with limit error → chunk', () => {
    assert.equal(nextAfterBase64Failure('HTTP 413', 1_024), 'chunk');
    assert.equal(nextAfterBase64Failure('Multipart body exceeds the 25 MB upload limit', MULTIPART_LIMIT), 'chunk');
  });

  it('nextAfterBase64Failure: small file without limit error → null (rethrow)', () => {
    assert.equal(nextAfterBase64Failure('network timeout', 1_024), null);
    assert.equal(nextAfterBase64Failure('HTTP 500', MULTIPART_LIMIT), null);
    assert.equal(nextAfterBase64Failure('', 0), null);
  });
});

describe('domain/transcription/policy — chunk helpers', () => {
  it('alignedChunkBytes: 16 kHz mono s16le (32000 B/s, align 2) for 600 s → 19_200_000', () => {
    assert.equal(alignedChunkBytes(32_000, 2, 600), 19_200_000);
    // 1 s chunk should be exactly 1 second of audio
    assert.equal(alignedChunkBytes(32_000, 2, 1), 32_000);
  });

  it('alignedChunkBytes rounds down to blockAlign', () => {
    // Odd bytes-per-second with blockAlign 2 must not split a sample frame
    assert.equal(alignedChunkBytes(3, 2, 1), 2);
    assert.equal(alignedChunkBytes(7, 4, 1), 4);
    assert.equal(alignedChunkBytes(32_001, 2, 1), 32_000);
  });

  it('alignedChunkBytes: zero or negative chunkDurationSec → 0 (guarded by caller)', () => {
    assert.equal(alignedChunkBytes(32_000, 2, 0), 0);
  });

  it('joinTranscriptParts joins with blank line', () => {
    assert.equal(joinTranscriptParts(['a', 'b']), 'a\n\nb');
    assert.equal(joinTranscriptParts(['one']), 'one');
    assert.equal(joinTranscriptParts([]), '');
    assert.equal(joinTranscriptParts(['x', 'y', 'z']), 'x\n\ny\n\nz');
  });
});
