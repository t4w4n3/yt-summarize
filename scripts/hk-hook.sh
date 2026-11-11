#!/usr/bin/env bash
set -uo pipefail
# Entry point of the installed git hooks (see .mise/tasks/hooks.sh).
#
# The pre-commit gate prints one block per step. Interactive, that is useful.
# Inside a coding agent it floods the context window with output nobody reads
# unless a step failed. So when an agent is detected (AI_AGENT, the generic
# process marker, or PI_CODING_AGENT), stdout and stderr are redirected to two
# temp files and only their paths are printed: the agent greps them on failure.
# Manual runs are untouched. HK_AGENT_LOG=0/1 forces either mode.

hook="${1:?hook name required}"
shift

agent_mode=0
case "${HK_AGENT_LOG:-auto}" in
  1) agent_mode=1 ;;
  0) agent_mode=0 ;;
  *)
    if [ -n "${AI_AGENT:-}" ] || [ "${PI_CODING_AGENT:-}" = "true" ]; then
      agent_mode=1
    fi
    ;;
esac

if [ "$agent_mode" -eq 0 ]; then
  exec hk run "$hook" --from-hook "$@"
fi

out="$(mktemp "${TMPDIR:-/tmp}/hk-${hook}-stdout.XXXXXX")" || {
  printf '[hk %s] cannot create a temp file under %s\n' "$hook" "${TMPDIR:-/tmp}" >&2
  exit 1
}
err="$(mktemp "${TMPDIR:-/tmp}/hk-${hook}-stderr.XXXXXX")" || {
  printf '[hk %s] cannot create a temp file under %s\n' "$hook" "${TMPDIR:-/tmp}" >&2
  exit 1
}

hk run "$hook" --from-hook "$@" >"$out" 2>"$err"
status=$?

if [ "$status" -eq 0 ]; then
  printf '[hk %s] OK — stdout: %s | stderr: %s\n' "$hook" "$out" "$err"
else
  printf '[hk %s] FAILED (exit %s) — stdout: %s | stderr: %s\n' "$hook" "$status" "$out" "$err" >&2
fi
exit "$status"
