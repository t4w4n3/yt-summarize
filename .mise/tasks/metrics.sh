#!/usr/bin/env bash
set -euo pipefail
#MISE description="Report mise task usage metrics from .local/mise-metrics.jsonl"
#USAGE flag "--since <since>" help="Only records at or after date (e.g. 30d or 2026-08-01)"
#USAGE flag "--all" help="Include nested + hk/ci calls (default: human top-level only)"
#USAGE flag "--json" help="Output JSON instead of table"
#USAGE flag "--unused" help="Also list known tasks with zero calls in window"
#USAGE flag "--caller <caller>" help="Filter by caller (human|hk|ci)"
#USAGE flag "--include-nested" help="Include nested calls (keep caller filter)"
#USAGE flag "--help -h" help="Show help"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

# Forward usage flags to the report script.
ARGS=()
if [[ -n "${usage_since:-}" ]]; then ARGS+=(--since "$usage_since"); fi
if [[ "${usage_all:-}" == "true" ]]; then ARGS+=(--all); fi
if [[ "${usage_json:-}" == "true" ]]; then ARGS+=(--json); fi
if [[ "${usage_unused:-}" == "true" ]]; then ARGS+=(--unused); fi
if [[ -n "${usage_caller:-}" ]]; then ARGS+=(--caller "$usage_caller"); fi
if [[ "${usage_include_nested:-}" == "true" ]]; then ARGS+=(--include-nested); fi
if [[ "${usage_help:-}" == "true" ]]; then ARGS+=(--help); fi

exec node scripts/metrics-report.ts "${ARGS[@]}"
