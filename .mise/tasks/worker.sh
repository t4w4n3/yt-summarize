#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run the pipeline worker locally (no container) for worker/DB iteration"
#USAGE flag "-d --data-dir <dir>" help="Jobs SQLite directory" default=".local/data" env="DATA_DIR"
#USAGE flag "-a --artifacts-dir <dir>" help="Artifacts directory" default=".local/artifacts" env="ARTIFACTS_DIR"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "worker" "$@"
trap 'metrics_end $?' EXIT

mkdir -p "$usage_data_dir" "$usage_artifacts_dir"
echo "NOTE: paid stages decrypt the OpenRouter key from /secrets (a container mount); a local worker marks"
echo "      transcribe/summarize jobs failed. Use this task to iterate on db.ts/worker.ts only."
echo "      For the real pipeline run: mise run up"
echo "Local worker: data=$usage_data_dir artifacts=$usage_artifacts_dir"
DATA_DIR="$usage_data_dir" ARTIFACTS_DIR="$usage_artifacts_dir" node src/worker/worker.ts
