/**
 * Pure LCOV parser + layer aggregator for the coverage report.
 *
 * No I/O here — feed it LCOV text, get back per-layer coverage aggregates.
 * Kept pure so it can be unit-tested with literal expectations.
 *
 * LCOV record shape (per source file, one `SF:` ... `end_of_record` block):
 *   SF:<path>
 *   ... FN/FNDA/BRDA/DA line data (unused for aggregation dmn) ...
 *   LF:<lines found>
 *   LH:<lines hit>
 *   FNF:<functions found>
 *   FNH:<functions hit>
 *   BRF:<branches found>
 *   BRH:<branches hit>
 *   end_of_record
 */

export interface FileCoverage {
  path: string;
  layer: string;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
  functionsFound: number;
  functionsHit: number;
}

export interface LayerAggregate {
  layer: string;
  files: number;
  linesFound: number;
  linesHit: number;
  branchesFound: number;
  branchesHit: number;
  functionsFound: number;
  functionsHit: number;
}

/**
 * Map a source path to its layer = first directory segment after `src/`.
 * e.g. `src/domain/transcription/policy.ts` -> `domain`,
 *      `src/worker/stages/download.ts` -> `worker`,
 *      `src/app/server.ts` -> `app`.
 * Returns null for paths outside `src/` (e.g. node_modules, tests).
 */
export function layerOf(srcPath: string): string | null {
  const m = /^src\/([^/]+)\//.exec(srcPath);
  return m ? (m[1] ?? null) : null;
}

function pct(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return (numerator / denominator) * 100;
}

/** Parse raw LCOV text into per-file coverage records. */
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = [];
  let current: {
    path: string;
    LF: number;
    LH: number;
    FNF: number;
    FNH: number;
    BRF: number;
    BRH: number;
  } | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (line === 'end_of_record') {
      if (current) {
        files.push({
          path: current.path,
          layer: layerOf(current.path) ?? 'unknown',
          linesFound: current.LF,
          linesHit: current.LH,
          branchesFound: current.BRF,
          branchesHit: current.BRH,
          functionsFound: current.FNF,
          functionsHit: current.FNH,
        });
        current = null;
      }
      continue;
    }
    if (line.startsWith('SF:')) {
      current = {
        path: line.slice(3),
        LF: 0,
        LH: 0,
        FNF: 0,
        FNH: 0,
        BRF: 0,
        BRH: 0,
      };
      continue;
    }
    if (!current) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon);
    const value = Number(line.slice(colon + 1));
    if (Number.isNaN(value)) continue;
    switch (key) {
      case 'LF':
        current.LF = value;
        break;
      case 'LH':
        current.LH = value;
        break;
      case 'FNF':
        current.FNF = value;
        break;
      case 'FNH':
        current.FNH = value;
        break;
      case 'BRF':
        current.BRF = value;
        break;
      case 'BRH':
        current.BRH = value;
        break;
    }
  }
  return files;
}

/** Group per-file records by layer, summing raw counters. */
export function aggregateByLayer(files: FileCoverage[]): LayerAggregate[] {
  const map = new Map<string, LayerAggregate>();
  for (const f of files) {
    let agg = map.get(f.layer);
    if (!agg) {
      agg = {
        layer: f.layer,
        files: 0,
        linesFound: 0,
        linesHit: 0,
        branchesFound: 0,
        branchesHit: 0,
        functionsFound: 0,
        functionsHit: 0,
      };
      map.set(f.layer, agg);
    }
    agg.files += 1;
    agg.linesFound += f.linesFound;
    agg.linesHit += f.linesHit;
    agg.branchesFound += f.branchesFound;
    agg.branchesHit += f.branchesHit;
    agg.functionsFound += f.functionsFound;
    agg.functionsHit += f.functionsHit;
  }
  return [...map.values()].sort((a, b) => {
    if (a.layer === 'domain') return -1;
    if (b.layer === 'domain') return 1;
    return a.layer.localeCompare(b.layer);
  });
}

export interface LayerRow {
  layer: string;
  files: number;
  lines: number | null;
  branches: number | null;
  functions: number | null;
}

/** Build printable rows with percentage scores (null = nothing to cover). */
export function rowsForReport(aggregates: LayerAggregate[]): LayerRow[] {
  return aggregates.map((a) => ({
    layer: a.layer,
    files: a.files,
    lines: pct(a.linesHit, a.linesFound),
    branches: pct(a.branchesHit, a.branchesFound),
    functions: pct(a.functionsHit, a.functionsFound),
  }));
}

export const LAYERS = ['domain', 'worker', 'shared', 'vpn', 'app'] as const;
