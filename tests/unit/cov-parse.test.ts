/**
 * Unit tests — scripts/cov-parse.ts (pure LCOV parser + layer aggregator).
 * Independently derived literal expectations.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateByLayer,
  gateFailures,
  layerOf,
  parseCoverageArgs,
  parseLcov,
  rowsForReport,
} from '../../scripts/cov-parse.ts';

const SAMPLE_LCOV = [
  'SF:src/domain/transcription/policy.ts',
  'FN:1,(anonymous_1)',
  'FNDA:3,(anonymous_1)',
  'FNF:8',
  'FNH:8',
  'BRDA:1,0,0,3',
  'BRF:19',
  'BRH:17',
  'DA:1,3',
  'DA:2,3',
  'DA:3,0',
  'LF:62',
  'LH:60',
  'end_of_record',
  '',
  'SF:src/shared/db.ts',
  'FNF:14',
  'FNH:1',
  'BRF:5',
  'BRH:4',
  'LF:208',
  'LH:62',
  'end_of_record',
  '',
  'SF:src/worker/stages/download.ts',
  'FNF:1',
  'FNH:0',
  'BRF:0',
  'BRH:0',
  'LF:57',
  'LH:0',
  'end_of_record',
].join('\n');

describe('cov-parse — layerOf', () => {
  it('maps first segment after src/ to the layer', () => {
    assert.equal(layerOf('src/domain/transcription/policy.ts'), 'domain');
    assert.equal(layerOf('src/worker/stages/download.ts'), 'worker');
    assert.equal(layerOf('src/shared/db.ts'), 'shared');
    assert.equal(layerOf('src/vpn/socks5.ts'), 'vpn');
    assert.equal(layerOf('src/app/server.ts'), 'app');
  });

  it('returns null for paths outside src/', () => {
    assert.equal(layerOf('src/app.extra.ts'), null); // not a directory segment
    assert.equal(layerOf('node_modules/x/index.js'), null);
    assert.equal(layerOf('tests/unit/x.test.ts'), null);
    assert.equal(layerOf('src'), null);
  });
});

describe('cov-parse — parseLcov', () => {
  it('extracts lines/branches/functions per file with literal totals', () => {
    const files = parseLcov(SAMPLE_LCOV);
    assert.equal(files.length, 3);
    const [f0, f1, f2] = files;
    assert.ok(f0 && f1 && f2);

    assert.deepEqual(f0, {
      path: 'src/domain/transcription/policy.ts',
      layer: 'domain',
      linesFound: 62,
      linesHit: 60,
      branchesFound: 19,
      branchesHit: 17,
      functionsFound: 8,
      functionsHit: 8,
    });
    assert.deepEqual(f1.path, 'src/shared/db.ts');
    assert.deepEqual(f1.layer, 'shared');
    assert.equal(f1.linesFound, 208);
    assert.equal(f1.linesHit, 62);
    assert.deepEqual(f2.path, 'src/worker/stages/download.ts');
    assert.equal(f2.layer, 'worker');
    assert.equal(f2.linesHit, 0);
  });

  it('ignores non-counter LCOV keys and NaN values', () => {
    const files = parseLcov(
      [
        'SF:src/shared/config.ts',
        'DA:1,2', // DA is not aggregated in our model — ignored
        'LF:31',
        'LH:31',
        'end_of_record',
      ].join('\n'),
    );
    assert.equal(files.length, 1);
    const [f0] = files;
    assert.ok(f0);
    assert.equal(f0.linesFound, 31);
    assert.equal(f0.linesHit, 31);
  });

  it('handles empty input', () => {
    assert.deepEqual(parseLcov(''), []);
  });
});

describe('cov-parse — aggregateByLayer', () => {
  it('sums counters by layer and orders domain first', () => {
    const aggregates = aggregateByLayer(parseLcov(SAMPLE_LCOV));
    assert.equal(aggregates.length, 3);
    const [a0, a1, a2] = aggregates;
    assert.ok(a0 && a1 && a2);
    assert.equal(a0.layer, 'domain');
    assert.equal(a0.linesFound, 62);
    assert.equal(a0.linesHit, 60);
    assert.equal(a1.layer, 'shared');
    assert.equal(a1.linesFound, 208);
    assert.equal(a1.linesHit, 62);
    assert.equal(a2.layer, 'worker');
    assert.equal(a2.linesFound, 57);
    assert.equal(a2.linesHit, 0);
  });
});

describe('cov-parse — parseCoverageArgs', () => {
  it('parses --min-lines <pct>', () => {
    assert.deepEqual(parseCoverageArgs(['--min-lines', '80']), { minLines: 80 });
  });

  it('parses the short alias -m <pct>', () => {
    assert.deepEqual(parseCoverageArgs(['-m', '80']), { minLines: 80 });
  });

  it('defaults to no threshold when the flag is absent', () => {
    assert.deepEqual(parseCoverageArgs([]), { minLines: null });
  });

  it('rejects percentages outside [0, 100]', () => {
    assert.throws(() => parseCoverageArgs(['--min-lines', '101']), /between 0 and 100/);
    assert.throws(() => parseCoverageArgs(['-m', '-1']), /between 0 and 100/);
  });

  it('rejects a missing or non-numeric value', () => {
    assert.throws(() => parseCoverageArgs(['--min-lines']), /expects a percentage/);
    assert.throws(() => parseCoverageArgs(['-m', 'abc']), /expects a percentage/);
  });

  it('rejects unknown arguments', () => {
    assert.throws(() => parseCoverageArgs(['--bogus']), /Unknown argument/);
  });
});

describe('cov-parse — gateFailures', () => {
  const rows = [
    { layer: 'domain', files: 1, lines: 100, branches: 100, functions: 100 },
    { layer: 'worker', files: 9, lines: 94.7, branches: 78.7, functions: 83.9 },
    { layer: 'app', files: 1, lines: 85, branches: null, functions: null },
  ];

  it('passes when every layer is at or above the threshold', () => {
    assert.deepEqual(gateFailures(rows, 80), []);
  });

  it('reports every layer strictly below the threshold', () => {
    const failures = gateFailures(rows, 95);
    assert.equal(failures.length, 2);
    assert.match(failures[0] ?? '', /worker/);
    assert.match(failures[0] ?? '', /94\.7%/);
    assert.match(failures[1] ?? '', /app/);
  });

  it('fails layers with no measurable lines (nothing covered)', () => {
    // A layer present in the report but with no covered files cannot pass any gate.
    const failures = gateFailures([{ layer: 'vpn', files: 0, lines: null, branches: null, functions: null }], 0);
    assert.equal(failures.length, 1);
    assert.match(failures[0] ?? '', /vpn/);
  });

  it('passes an empty report', () => {
    assert.deepEqual(gateFailures([], 80), []);
  });
});

describe('cov-parse — rowsForReport', () => {
  it('computes percentages and nulls on empty denominators', () => {
    const aggregates = aggregateByLayer(parseLcov(SAMPLE_LCOV));
    const rows = rowsForReport(aggregates);

    const domain = rows.find((r) => r.layer === 'domain');
    assert.ok(domain);
    // 60/62 lines -> 96.774...%; 17/19 branches; 8/8 functions
    assert.equal(domain.lines, (60 / 62) * 100);
    assert.equal(domain.branches, (17 / 19) * 100);
    assert.equal(domain.functions, 100);

    const worker = rows.find((r) => r.layer === 'worker');
    assert.ok(worker);
    assert.equal(worker.lines, 0); // 0/57 lines
    assert.equal(worker.branches, null); // 0/0 branches -> null (nothing to cover)
    assert.equal(worker.functions, 0); // 0/1 functions (FNF:1, FNH:0)
  });
});
