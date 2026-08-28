#!/usr/bin/env node
/**
 * Coverage report for the summarize-yt repo.
 *
 * Runs the hermetic test gate (unit + integration) under the Node built-in
 * test runner's coverage, then reports line/branch/function coverage scores
 * per layer:
 *
 *   domain  — pure logic, no I/O (src/domain/**)
 *   worker  — outbound adapters / orchestration (src/worker/**: stages,
 *             pipeline, worker bootstrap)
 *   shared  — shared supporting modules (src/shared/**)
 *   vpn     — Mullvad SOCKS sidecar client (src/vpn/**)
 *   app     — web app surface (src/app/**)
 *
 * Zero dependencies: uses `node --test --experimental-test-coverage` with the
 * `lcov` reporter and parses the output with scripts/cov-parse.ts.
 *
 * Usage: node scripts/coverage.ts [--min-lines <pct>]
 *   --min-lines <pct>  fail (exit 1) if any layer's line coverage is below pct.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { aggregateByLayer, type FileCoverage, type LayerRow, layerOf, parseLcov, rowsForReport } from './cov-parse.ts';

const TEST_GLOBS = ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'];

function printRow(row: LayerRow): string {
  const fmt = (v: number | null): string => (v === null ? '  —  ' : `${v.toFixed(1).padStart(5)}%`);
  return `${row.layer.padEnd(14)} ${String(row.files).padStart(3)} files   lines ${fmt(row.lines)}   branches ${fmt(row.branches)}   fns ${fmt(row.functions)}`;
}

interface Mode {
  minLines: number | null;
}

function parseArgs(argv: string[]): Mode {
  const mode: Mode = { minLines: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--min-lines') {
      const value = Number(argv[i + 1]);
      if (Number.isNaN(value) || value < 0 || value > 100) {
        throw new Error('--min-lines expects a percentage between 0 and 100');
      }
      mode.minLines = value;
      i++;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return mode;
}

/**
 * Enumerate every `.ts` file under src/ (excluding tests) with its total line
 * count. Used to surface files the coverage run never executed (0%).
 *
 * Only files that contain executable code (a function/arrow) are counted;
 * pure declaration modules (`interface`/`type` only, e.g. ports.ts) have no
 * runtime behaviour to cover and would otherwise dilute the score to 0%.
 */
function allSourceFiles(): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        const content = readFileSync(full, 'utf8');
        // Executable-code heuristic: a named function or an arrow function.
        if (!/\bfunction\b|=>/.test(content)) continue;
        out.set(full, content.split('\n').length);
      }
    }
  };
  walk('src');
  return out;
}

/**
 * Merge zero-coverage records for every src file never executed by the run,
 * so layer aggregates reflect true size (uncovered adapters appear at 0%).
 */
function mergeUnexecuted(covered: FileCoverage[], sources: Map<string, number>): FileCoverage[] {
  const done = new Set(covered.map((f) => f.path));
  const merged = [...covered];
  for (const [path, lines] of sources) {
    if (done.has(path)) continue;
    const layer = layerOf(path);
    if (layer === null) continue;
    merged.push({
      path,
      layer,
      linesFound: lines,
      linesHit: 0,
      branchesFound: 0,
      branchesHit: 0,
      functionsFound: 0,
      functionsHit: 0,
    });
  }
  return merged;
}

function main(): void {
  const mode = parseArgs(process.argv.slice(2));
  const dir = mkdtempSync(join(tmpdir(), 'cov-report-'));
  const lcovPath = join(dir, 'lcov.info');

  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--experimental-test-coverage',
      '--test-reporter=lcov',
      '--test-coverage-exclude=node_modules/**',
      '--test-coverage-exclude=tests/**',
      '--test-coverage-exclude=scripts/**',
      `--test-reporter-destination=${lcovPath}`,
      ...TEST_GLOBS,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] },
  );

  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    process.exit(result.status ?? 1);
  }

  const lcov = readFileSync(lcovPath, 'utf8');
  const covered = parseLcov(lcov);
  const files = mergeUnexecuted(covered, allSourceFiles());
  const aggregates = aggregateByLayer(files);
  const rows = rowsForReport(aggregates);

  console.log('');
  console.log('Coverage — hermetic gate (unit + integration)');
  console.log('Layer        files   line / branch / function coverage');
  console.log('------------------------------------------------------');
  for (const row of rows) console.log(printRow(row));

  rmSync(dir, { recursive: true, force: true });

  if (mode.minLines !== null) {
    let failed = false;
    for (const row of rows) {
      if (row.lines !== null && row.lines < mode.minLines) {
        console.error(`\nFAIL: ${row.layer} line coverage ${row.lines.toFixed(1)}% < ${mode.minLines}%`);
        failed = true;
      }
    }
    for (const row of rows) {
      if (row.lines === null || row.files === 0) {
        console.error(`\nFAIL: ${row.layer} has no covered files (coverage < ${mode.minLines}%)`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
  }
}

main();
