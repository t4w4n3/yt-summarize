/**
 * Unit tests — scripts/metrics-report.ts (pure parser + aggregator for mise task metrics).
 * Independently derived literal expectations.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  aggregateByTask,
  filterSince,
  findUnusedTasks,
  parseMetricsFile,
  parseMetricsLine,
} from '../../scripts/metrics-report.ts';

// Sample JSONL lines — literal expectations derived from spec, not from production code.
const LINE_OK_1 =
  '{"ts":"2026-08-29T10:00:00.000Z","task":"up","argv":[],"dur_ms":18234,"exit":0,"caller":"human","parent":"up","is_nested":false}';
const LINE_OK_2 =
  '{"ts":"2026-08-29T10:05:00.000Z","task":"lint-js","argv":["--fix"],"dur_ms":1200,"exit":0,"caller":"human","parent":"lint-js","is_nested":false}';
const LINE_NESTED =
  '{"ts":"2026-08-29T10:06:00.000Z","task":"lint-js","argv":[],"dur_ms":1100,"exit":1,"caller":"human","parent":"lint","is_nested":true}';
const LINE_HK =
  '{"ts":"2026-08-29T11:00:00.000Z","task":"lint-js","argv":[],"dur_ms":900,"exit":0,"caller":"hk","parent":"lint-js","is_nested":false}';
const LINE_OLD =
  '{"ts":"2026-07-01T09:00:00.000Z","task":"backup","argv":[],"dur_ms":500,"exit":0,"caller":"human","parent":"backup","is_nested":false}';

describe('metrics-report — parseMetricsLine', () => {
  it('parses a valid JSONL line with literal fields', () => {
    const r = parseMetricsLine(LINE_OK_1);
    assert.ok(r);
    assert.equal(r.task, 'up');
    assert.deepEqual(r.argv, []);
    assert.equal(r.dur_ms, 18234);
    assert.equal(r.exit, 0);
    assert.equal(r.caller, 'human');
    assert.equal(r.parent, 'up');
    assert.equal(r.is_nested, false);
    assert.equal(r.ts, '2026-08-29T10:00:00.000Z');
  });

  it('parses argv array and is_nested true', () => {
    const r = parseMetricsLine(LINE_NESTED);
    assert.ok(r);
    assert.equal(r.task, 'lint-js');
    assert.deepEqual(r.argv, []);
    assert.equal(r.dur_ms, 1100);
    assert.equal(r.exit, 1);
    assert.equal(r.caller, 'human');
    assert.equal(r.parent, 'lint');
    assert.equal(r.is_nested, true);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseMetricsLine('not json'), null);
    assert.equal(parseMetricsLine(''), null);
  });

  it('returns null when required fields are missing or wrong type', () => {
    assert.equal(parseMetricsLine('{"task":"up"}'), null);
    assert.equal(
      parseMetricsLine(
        '{"ts":"2026-08-29T10:00:00.000Z","task":"up","argv":[],"dur_ms":"bad","exit":0,"caller":"human","parent":"up","is_nested":false}',
      ),
      null,
    );
    assert.equal(
      parseMetricsLine(
        '{"ts":"bad-date","task":"up","argv":[],"dur_ms":100,"exit":0,"caller":"human","parent":"up","is_nested":false}',
      ),
      null,
    );
  });

  it('defaults missing optional fields (caller, is_nested)', () => {
    const r = parseMetricsLine('{"ts":"2026-08-29T10:00:00.000Z","task":"up","argv":[],"dur_ms":100,"exit":0}');
    assert.ok(r);
    assert.equal(r.caller, 'human');
    assert.equal(r.is_nested, false);
    assert.equal(r.parent, 'up');
  });
});

describe('metrics-report — parseMetricsFile', () => {
  it('splits JSONL, skips empty and invalid lines', () => {
    const content = [LINE_OK_1, '', 'bad line', LINE_OK_2, LINE_NESTED].join('\n');
    const records = parseMetricsFile(content);
    assert.equal(records.length, 3);
    assert.equal(records[0]?.task, 'up');
    assert.equal(records[1]?.task, 'lint-js');
    assert.equal(records[2]?.task, 'lint-js');
  });

  it('returns empty for empty input', () => {
    assert.deepEqual(parseMetricsFile(''), []);
    assert.deepEqual(parseMetricsFile('\n\n'), []);
  });
});

describe('metrics-report — filterSince', () => {
  it('keeps records at or after since, drops older', () => {
    const records = parseMetricsFile([LINE_OLD, LINE_OK_1, LINE_OK_2].join('\n'));
    const since = new Date('2026-08-01T00:00:00.000Z');
    const filtered = filterSince(records, since);
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0]?.task, 'up');
    assert.equal(filtered[1]?.task, 'lint-js');
  });

  it('returns all when since is null', () => {
    const records = parseMetricsFile([LINE_OLD, LINE_OK_1].join('\n'));
    assert.equal(filterSince(records, null).length, 2);
  });
});

describe('metrics-report — aggregateByTask', () => {
  it('aggregates calls, lastUsed, avgDur, fail rate with literal expectations', () => {
    const records = parseMetricsFile([LINE_OK_1, LINE_OK_2, LINE_NESTED, LINE_HK, LINE_OLD].join('\n'));
    // default: exclude nested and filter caller=human (hk excluded)
    const agg = aggregateByTask(records, { excludeNested: true, caller: 'human' });
    // should contain up(1), lint-js (1 human non-nested), backup(1) — hk and nested excluded
    assert.equal(agg.length, 3);
    const up = agg.find((a) => a.task === 'up');
    assert.ok(up);
    assert.equal(up.calls, 1);
    assert.equal(up.lastUsed, '2026-08-29T10:00:00.000Z');
    assert.equal(up.avgDurMs, 18234);
    assert.equal(up.failCount, 0);
    assert.equal(up.failRate, 0);

    const lint = agg.find((a) => a.task === 'lint-js');
    assert.ok(lint);
    assert.equal(lint.calls, 1);
    assert.equal(lint.avgDurMs, 1200);
    assert.equal(lint.failCount, 0);

    const backup = agg.find((a) => a.task === 'backup');
    assert.ok(backup);
    assert.equal(backup.calls, 1);
  });

  it('includes nested and hk when options disabled', () => {
    const records = parseMetricsFile([LINE_OK_2, LINE_NESTED, LINE_HK].join('\n'));
    const aggAll = aggregateByTask(records, { excludeNested: false, caller: null });
    const lint = aggAll.find((a) => a.task === 'lint-js');
    assert.ok(lint);
    assert.equal(lint.calls, 3);
    // avg = (1200+1100+900)/3 = 1066.666...
    assert.ok(Math.abs((lint.avgDurMs ?? 0) - 1066.6666666666667) < 0.001);
    assert.equal(lint.failCount, 1);
    assert.ok(Math.abs(lint.failRate - 1 / 3) < 0.0001);
    assert.equal(lint.lastUsed, '2026-08-29T11:00:00.000Z');
  });

  it('sorts by calls descending then task name', () => {
    const records = parseMetricsFile([LINE_OK_1, LINE_OK_2, LINE_OK_2].join('\n'));
    const agg = aggregateByTask(records, { excludeNested: true, caller: null });
    assert.equal(agg[0]?.task, 'lint-js');
    assert.equal(agg[0]?.calls, 2);
    assert.equal(agg[1]?.task, 'up');
  });

  it('returns empty for no records', () => {
    assert.deepEqual(aggregateByTask([], { excludeNested: true, caller: 'human' }), []);
  });
});

describe('metrics-report — findUnusedTasks', () => {
  it('returns known tasks with zero calls', () => {
    const records = parseMetricsFile([LINE_OK_1, LINE_OK_2].join('\n'));
    const agg = aggregateByTask(records, { excludeNested: true, caller: null });
    const unused = findUnusedTasks(agg, ['up', 'lint-js', 'backup', 'restore', 'mullvad']);
    assert.deepEqual(unused.sort(), ['backup', 'mullvad', 'restore']);
  });

  it('returns all known when no calls', () => {
    assert.deepEqual(findUnusedTasks([], ['up', 'lint']).sort(), ['lint', 'up']);
  });

  it('returns empty when every known task was seen', () => {
    const records = parseMetricsFile([LINE_OK_1].join('\n'));
    const agg = aggregateByTask(records, { excludeNested: true, caller: null });
    assert.deepEqual(findUnusedTasks(agg, ['up']), []);
  });
});
