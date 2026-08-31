#!/usr/bin/env bash
# Shared helper for mise task metrics — sourced by each task.
# Appends one JSONL line to .local/mise-metrics.jsonl via flock (best-effort, silent).
# Usage in a task:
#   ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
#   source "$ROOT/scripts/metrics.sh"
#   metrics_start "task-name" "$@"
#   trap 'metrics_end $?' EXIT
# Opt-out: MISE_METRICS=0
# Caller tagging: METRICS_CALLER=hk (set by hk.pkl), CI=1, or auto-detected via ppid.

_metrics_now_ms() {
  local ms
  ms=$(date +%s%3N 2>/dev/null)
  if [[ "$ms" == *"%3N"* ]] || [[ -z "$ms" ]]; then
    ms=$(date +%s 2>/dev/null || echo 0)
    # ms is seconds — convert to millis
    ms=$((ms * 1000))
  fi
  printf '%s' "$ms"
}

metrics_start() {
  local task="${1:-unknown}"
  shift || true
  _METRICS_TASK="$task"
  # capture args as JSON array (best-effort via python3)
  if command -v python3 >/dev/null 2>&1; then
    _METRICS_ARGS_JSON=$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$@" 2>/dev/null) || _METRICS_ARGS_JSON="[]"
  else
    _METRICS_ARGS_JSON="[]"
  fi
  _METRICS_T0=$(_metrics_now_ms)
  export _METRICS_TASK _METRICS_ARGS_JSON _METRICS_T0

  # parent propagation: first caller wins (top-level)
  if [[ -z "${METRICS_PARENT:-}" ]]; then
    export METRICS_PARENT="$task"
    _METRICS_IS_NESTED="false"
  else
    if [[ "$task" == "${METRICS_PARENT}" ]]; then
      _METRICS_IS_NESTED="false"
    else
      _METRICS_IS_NESTED="true"
    fi
  fi
  export _METRICS_IS_NESTED
}

metrics_end() {
  local exit_code="${1:-$?}"
  # opt-out and guard (idempotent — trap EXIT may fire after explicit call)
  if [[ "${MISE_METRICS:-1}" == "0" ]]; then
    unset _METRICS_T0 _METRICS_TASK _METRICS_ARGS_JSON _METRICS_IS_NESTED 2>/dev/null || true
    return 0
  fi
  if [[ -z "${_METRICS_T0:-}" ]] || [[ -z "${_METRICS_TASK:-}" ]]; then
    return 0
  fi

  local end_ms dur_ms caller parent is_nested ts line metrics_file lock_file root_dir
  end_ms=$(_metrics_now_ms)
  dur_ms=$((end_ms - _METRICS_T0))
  if [[ "$dur_ms" -lt 0 ]]; then
    dur_ms=0
  fi

  # caller detection: explicit METRICS_CALLER wins, then CI, then hk ppid, else human
  caller="${METRICS_CALLER:-}"
  if [[ -z "$caller" ]]; then
    if [[ -n "${CI:-}" ]] || [[ -n "${GITHUB_ACTIONS:-}" ]] || [[ -n "${GITLAB_CI:-}" ]]; then
      caller="ci"
    else
      # best-effort hk detection via parent process args (silent)
      if ps -o args= -p "${PPID:-1}" 2>/dev/null | grep -qE '(^|[ /])hk([ /]|$)' 2>/dev/null; then
        caller="hk"
      else
        caller="human"
      fi
    fi
  fi

  parent="${METRICS_PARENT:-$_METRICS_TASK}"
  is_nested="${_METRICS_IS_NESTED:-false}"
  ts=$(date -u +%Y-%m-%dT%H:%M:%S.000Z 2>/dev/null || date -u +%FT%TZ 2>/dev/null || printf '1970-01-01T00:00:00.000Z')

  # prepare env for python JSON builder
  export _METRICS_TS="$ts" _METRICS_DUR="$dur_ms" _METRICS_EXIT="$exit_code" _METRICS_CALLER_EFF="$caller" _METRICS_PARENT_EFF="$parent" _METRICS_IS_NESTED_EFF="$is_nested"

  if command -v python3 >/dev/null 2>&1; then
    line=$(python3 -c '
import json, os
task = os.environ.get("_METRICS_TASK","unknown")
argv = json.loads(os.environ.get("_METRICS_ARGS_JSON","[]"))
ts = os.environ.get("_METRICS_TS","1970-01-01T00:00:00.000Z")
dur = int(os.environ.get("_METRICS_DUR","0"))
exit_code = int(os.environ.get("_METRICS_EXIT","0"))
caller = os.environ.get("_METRICS_CALLER_EFF","human")
parent = os.environ.get("_METRICS_PARENT_EFF","")
is_nested = os.environ.get("_METRICS_IS_NESTED_EFF","false") == "true"
obj = {"ts": ts, "task": task, "argv": argv, "dur_ms": dur, "exit": exit_code, "caller": caller, "parent": parent, "is_nested": is_nested}
print(json.dumps(obj, separators=(",", ":")))
' 2>/dev/null) || line=""
  else
    line=""
  fi

  # fallback if python not available or failed — minimal escaping
  if [[ -z "$line" ]]; then
    # naive: task/caller/parent are simple slugs, argv already JSON
    line="{\"ts\":\"$ts\",\"task\":\"$_METRICS_TASK\",\"argv\":${_METRICS_ARGS_JSON:-[]},\"dur_ms\":$dur_ms,\"exit\":$exit_code,\"caller\":\"$caller\",\"parent\":\"$parent\",\"is_nested\":$is_nested}"
  fi

  root_dir="${ROOT:-$(pwd)}"
  metrics_file="${METRICS_FILE:-$root_dir/.local/mise-metrics.jsonl}"
  lock_file="$root_dir/.local/metrics.lock"
  mkdir -p "$(dirname "$metrics_file")" 2>/dev/null || true
  # append with flock when available (non-blocking, silent)
  if command -v flock >/dev/null 2>&1; then
    (
      flock -n 200 2>/dev/null || true
      printf '%s\n' "$line" >>"$metrics_file" 2>/dev/null || true
    ) 200>"$lock_file" 2>/dev/null || printf '%s\n' "$line" >>"$metrics_file" 2>/dev/null || true
  else
    printf '%s\n' "$line" >>"$metrics_file" 2>/dev/null || true
  fi

  unset _METRICS_T0 _METRICS_TASK _METRICS_ARGS_JSON _METRICS_IS_NESTED _METRICS_TS _METRICS_DUR _METRICS_EXIT _METRICS_CALLER_EFF _METRICS_PARENT_EFF _METRICS_IS_NESTED_EFF 2>/dev/null || true
  return 0
}
