#!/usr/bin/env bash
set -euo pipefail
#MISE description="Install the git hook shims that route hk output through scripts/hk-hook.sh"

# `hk install` rewrites .git/hooks/<hook> with its own one-liner, which pipes
# the whole gate to the terminal. This task runs after it (mise postinstall)
# and swaps in a shim that goes through scripts/hk-hook.sh, so an agent commit
# gets two temp-file paths instead of the full output.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

hooks_dir="$(git rev-parse --git-path hooks)"
mkdir -p "$hooks_dir"

for hook in pre-commit pre-push; do
  target="$hooks_dir/$hook"
  cat >"$target" <<EOF
#!/bin/sh
test "\${HK:-1}" = "0" || exec mise x -- ./scripts/hk-hook.sh $hook "\$@"
EOF
  chmod +x "$target"
  printf 'installed %s\n' "$target"
done
