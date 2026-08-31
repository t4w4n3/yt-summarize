import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pure parser + aggregator for mise task metrics JSONL.
 *
 * No I/O here — feed it JSONL text, get back per-task aggregates.
 * Kept pure for unit tests; I/O lives below in the CLI runner.
 */

export interface MetricRecord {
  ts: string;
  task: string;
  argv: string[];
  dur_ms: number;
  exit: number;
  caller: string;
  parent: string;
  is_nested: boolean;
}

export interface TaskAggregate {
  task: string;
  calls: number;
  lastUsed: string | null;
  avgDurMs: number | null;
  failCount: number;
  failRate: number;
}

/**
 * Parse a single JSONL line into a MetricRecord.
 * Returns null for empty / invalid / missing required fields.
 */
export function parseMetricsLine(line: string): MetricRecord | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;

  const ts = o.ts;
  const task = o.task;
  const argv = o.argv;
  const durMs = o.dur_ms;
  const exit = o.exit;
  const caller = o.caller;
  const parent = o.parent;
  const isNested = o.is_nested;

  if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
  if (typeof task !== 'string' || task.trim() === '') return null;
  if (typeof durMs !== 'number' || !Number.isFinite(durMs) || durMs < 0) return null;
  if (typeof exit !== 'number' || !Number.isFinite(exit) || !Number.isInteger(exit) || exit < 0) return null;

  let argvArr: string[];
  if (argv === undefined) {
    argvArr = [];
  } else if (Array.isArray(argv) && argv.every((v) => typeof v === 'string')) {
    argvArr = argv as string[];
  } else {
    return null;
  }

  const callerStr = typeof caller === 'string' && caller.trim() !== '' ? caller : 'human';
  const parentStr = typeof parent === 'string' && parent.trim() !== '' ? parent : (task as string);
  const nested = typeof isNested === 'boolean' ? isNested : false;

  return {
    ts: ts as string,
    task: task as string,
    argv: argvArr,
    dur_ms: durMs as number,
    exit: exit as number,
    caller: callerStr,
    parent: parentStr,
    is_nested: nested,
  };
}

/** Parse raw JSONL text into records, skipping empty/invalid lines. */
export function parseMetricsFile(content: string): MetricRecord[] {
  const out: MetricRecord[] = [];
  for (const line of content.split('\n')) {
    const r = parseMetricsLine(line);
    if (r) out.push(r);
  }
  return out;
}

/** Filter records keeping only those at or after `since` (inclusive). */
export function filterSince(records: MetricRecord[], since: Date | null): MetricRecord[] {
  if (since === null) return [...records];
  const t = since.getTime();
  return records.filter((r) => {
    const d = Date.parse(r.ts);
    return !Number.isNaN(d) && d >= t;
  });
}

export interface AggregateOptions {
  excludeNested?: boolean;
  caller?: string | null;
}

/**
 * Aggregate records by task.
 * Options:
 *  - excludeNested: when true, skip records where is_nested === true
 *  - caller: when non-null, keep only records where caller === value
 * Sorted by calls descending, then task name ascending.
 */
export function aggregateByTask(records: MetricRecord[], options: AggregateOptions = {}): TaskAggregate[] {
  const excludeNested = options.excludeNested ?? false;
  const callerFilter = options.caller ?? null;

  const filtered = records.filter((r) => {
    if (excludeNested && r.is_nested) return false;
    if (callerFilter !== null && r.caller !== callerFilter) return false;
    return true;
  });

  const map = new Map<
    string,
    { calls: number; lastUsedMs: number; lastUsed: string; sumDur: number; failCount: number }
  >();

  for (const r of filtered) {
    const ms = Date.parse(r.ts);
    const existing = map.get(r.task);
    if (!existing) {
      map.set(r.task, {
        calls: 1,
        lastUsedMs: ms,
        lastUsed: r.ts,
        sumDur: r.dur_ms,
        failCount: r.exit === 0 ? 0 : 1,
      });
    } else {
      existing.calls += 1;
      existing.sumDur += r.dur_ms;
      if (ms > existing.lastUsedMs) {
        existing.lastUsedMs = ms;
        existing.lastUsed = r.ts;
      }
      if (r.exit !== 0) existing.failCount += 1;
    }
  }

  const aggregates: TaskAggregate[] = [];
  for (const [task, v] of map) {
    aggregates.push({
      task,
      calls: v.calls,
      lastUsed: v.lastUsed,
      avgDurMs: v.calls > 0 ? v.sumDur / v.calls : null,
      failCount: v.failCount,
      failRate: v.calls > 0 ? v.failCount / v.calls : 0,
    });
  }

  aggregates.sort((a, b) => {
    if (b.calls !== a.calls) return b.calls - a.calls;
    return a.task.localeCompare(b.task);
  });

  return aggregates;
}

/** Find known tasks with zero calls in the aggregates. */
export function findUnusedTasks(aggregates: TaskAggregate[], knownTasks: string[]): string[] {
  const seen = new Set(aggregates.map((a) => a.task));
  return knownTasks.filter((t) => !seen.has(t));
}

// ── CLI helpers (kept pure for tests, I/O in the runner below) ──

export interface ReportOptions {
  since: Date | null;
  excludeNested: boolean;
  caller: string | null;
  format: 'table' | 'json';
  showUnused: boolean;
  knownTasks: string[];
}

export function parseReportArgs(argv: string[]): ReportOptions {
  const knownTasks: string[] = [];
  let since: Date | null = null;
  let excludeNested = true;
  let caller: string | null = 'human';
  let format: 'table' | 'json' = 'table';
  let showUnused = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--since' || a === '--since-days') {
      // deprecated alias handling: treat as flag with value
    }
    if (a === '--since' || a === '--since-days' || a === '-s') {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} expects a value (e.g. 30d or 2026-08-01)`);
      since = parseSinceValue(v);
    } else if (a?.startsWith('--since=')) {
      since = parseSinceValue(a.slice('--since='.length));
    } else if (a === '--all') {
      excludeNested = false;
      caller = null;
    } else if (a === '--json') {
      format = 'json';
    } else if (a === '--unused') {
      showUnused = true;
    } else if (a === '--caller') {
      const v = argv[++i];
      if (v === undefined) throw new Error('--caller expects a value (human|hk|ci)');
      caller = v;
      excludeNested = false; // when explicitly filtering by caller, caller wants full view unless they set --human-only
      if (v === 'human') excludeNested = true;
    } else if (a === '--include-nested') {
      excludeNested = false;
    } else if (a === '--help' || a === '-h') {
      throw new Error('help');
    } else if (a?.startsWith('-')) {
      throw new Error(`Unknown argument: ${a}`);
    } else {
      // positional not expected
      throw new Error(`Unknown argument: ${a}`);
    }
  }

  return { since, excludeNested, caller, format, showUnused, knownTasks };
}

export function parseSinceValue(v: string): Date {
  const trimmed = v.trim();
  // 30d / 7d / 90d
  const m = /^(\d+)d$/.exec(trimmed);
  if (m) {
    const days = Number(m[1]);
    if (!Number.isFinite(days)) throw new Error(`Invalid --since value: ${v}`);
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
  // ISO date
  const d = new Date(trimmed);
  if (!Number.isNaN(d.getTime())) return d;
  throw new Error(`Invalid --since value: ${v} (use 30d or YYYY-MM-DD)`);
}

export function formatTable(aggregates: TaskAggregate[]): string {
  if (aggregates.length === 0) return 'No metrics yet (run some mise tasks first).';
  const header = `${'task'.padEnd(20)} ${'calls'.padStart(5)}  ${'lastUsed'.padEnd(24)} ${'avg'.padStart(7)}  ${'fail%'.padStart(5)}`;
  const sep = '-'.repeat(header.length);
  const rows = aggregates.map((a) => {
    const avg = a.avgDurMs === null ? '  —  ' : `${(a.avgDurMs / 1000).toFixed(1).padStart(5)}s`;
    const fail = `${(a.failRate * 100).toFixed(0).padStart(4)}%`;
    const last = (a.lastUsed ?? '—').slice(0, 24).padEnd(24);
    return `${a.task.padEnd(20)} ${String(a.calls).padStart(5)}  ${last} ${avg}  ${fail}`;
  });
  return [header, sep, ...rows].join('\n');
}

// ── I/O + CLI (not unit-tested, integration via .mise/tasks/metrics.sh) ──

export function listKnownTasks(rootDir: string): string[] {
  try {
    const dir = join(rootDir, '.mise/tasks');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.sh'))
      .map((f) => f.slice(0, -3))
      .sort();
  } catch {
    return [];
  }
}

export function readMetricsFile(filePath: string): string {
  try {
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function printHelp(): void {
  console.log(`mise task metrics — report usage from .local/mise-metrics.jsonl

Usage: node scripts/metrics-report.ts [options]
       mise run metrics [-- <options>]

Options:
  --since <30d|YYYY-MM-DD>  only records at or after date (default: all time)
  --since 30d               shorthand: last N days
  --all                     include nested + hk/ci calls (default: human top-level only)
  --include-nested          include nested calls (keep caller filter)
  --caller <human|hk|ci>    filter by caller (default human; with --all no filter)
  --json                    output JSON instead of table
  --unused                  also list known tasks with zero calls
  --help, -h                show this help

Examples:
  mise run metrics
  mise run metrics -- --since 30d
  mise run metrics -- --all --json | jq
  mise run metrics -- --unused --since 90d`);
}

function main(): void {
  const argv = process.argv.slice(2);
  let opts: ReportOptions;
  try {
    opts = parseReportArgs(argv);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === 'help') {
      printHelp();
      process.exit(0);
    }
    console.error(`Error: ${msg}`);
    printHelp();
    process.exit(1);
  }

  const rootDir = process.cwd();
  const filePath = process.env.METRICS_FILE ?? join(rootDir, '.local/mise-metrics.jsonl');
  const content = readMetricsFile(filePath);
  const allRecords = parseMetricsFile(content);
  const filtered = filterSince(allRecords, opts.since);
  const aggregates = aggregateByTask(filtered, {
    excludeNested: opts.excludeNested,
    caller: opts.caller,
  });

  if (opts.format === 'json') {
    const known = opts.showUnused ? listKnownTasks(rootDir) : [];
    const unused = opts.showUnused ? findUnusedTasks(aggregates, known) : undefined;
    const payload: Record<string, unknown> = { aggregates };
    if (unused !== undefined) payload.unused = unused;
    if (opts.since) payload.since = opts.since.toISOString();
    payload.caller = opts.caller;
    payload.excludeNested = opts.excludeNested;
    payload.totalRecords = filtered.length;
    console.log(JSON.stringify(payload, null, 2));
  } else {
    if (filtered.length === 0) {
      console.log('No metrics yet — run some mise tasks first.');
      console.log(`(looking for ${filePath})`);
      if (opts.showUnused) {
        const known = listKnownTasks(rootDir);
        const unused = findUnusedTasks(aggregates, known);
        if (unused.length > 0) {
          console.log(`\nUnused tasks (${unused.length}/${known.length} known):`);
          console.log(unused.join(', '));
        }
      }
      return;
    }
    const label: string[] = [];
    if (opts.since) label.push(`since ${opts.since.toISOString().slice(0, 10)}`);
    label.push(opts.caller ? `caller=${opts.caller}` : 'all callers');
    label.push(opts.excludeNested ? 'top-level only' : 'incl. nested');
    console.log(`Metrics — ${label.join(' · ')} — ${filtered.length} records → ${aggregates.length} tasks`);
    console.log(formatTable(aggregates));
    if (opts.showUnused) {
      const known = listKnownTasks(rootDir);
      const unused = findUnusedTasks(aggregates, known);
      console.log('');
      if (unused.length === 0) {
        console.log(`All ${known.length} known tasks have been used in this window.`);
      } else {
        console.log(`Unused tasks (${unused.length}/${known.length} known) in this window:`);
        console.log(unused.join(', '));
        console.log(`Hint: candidates for removal or hide:true — verify with --all --since 90d`);
      }
    }
  }
}

// ESM entrypoint guard — run when invoked directly via `node scripts/metrics-report.ts`
const isDirectRun = process.argv[1]?.endsWith('metrics-report.ts');
if (isDirectRun) main();
