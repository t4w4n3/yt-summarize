#!/usr/bin/env bash
set -euo pipefail
#MISE description="Check prerequisites: tools, Node version, .env, GPG secrets"
#MISE alias="check"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail=0
ok()   { printf '  ok:   %s\n' "$1"; }
warn() { printf '  WARN: %s\n' "$1"; }

echo "mise:"
if command -v mise >/dev/null 2>&1; then
  ok "mise $(mise --version | awk '{print $1}')"
else
  warn "mise not on PATH (install from https://mise.jdx.dev)"
  fail=1
fi

echo "toolchain (provided by mise):"
NODE_MAJOR="$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')"
if [ -n "$NODE_MAJOR" ] && [ "$NODE_MAJOR" -ge 24 ]; then
  ok "node $(node --version) (>= 24 required)"
else
  warn "node >= 24 required, got $(node --version 2>/dev/null || echo 'none')"
  fail=1
fi
if npm --version >/dev/null 2>&1; then
  ok "npm $(npm --version)"
else
  warn "npm missing"
  fail=1
fi

echo "container tooling:"
if podman --version >/dev/null 2>&1; then
  ok "$(podman --version)"
else
  warn "podman missing (>= 5 required)"
  fail=1
fi
if podman-compose --version >/dev/null 2>&1; then
  ok "$(podman-compose --version 2>&1 | tail -n 1)"
else
  warn "podman-compose missing"
  fail=1
fi

echo "project config:"
if [ -f .env ]; then
  ok ".env present"
else
  warn ".env missing — run: mise run setup"
fi
if [ -d node_modules ]; then
  ok "node_modules present"
else
  warn "node_modules missing — run: mise run setup"
fi

echo "secrets (only the paid pipeline stages need these; e2e tests do not):"
if [ -f "$HOME/.secrets/openrouter.gpg" ]; then
  if GNUPGHOME="$HOME/.gnupg" gpg --quiet --batch --no-tty --decrypt \
      "$HOME/.secrets/openrouter.gpg" >/dev/null 2>&1; then
    ok "$HOME/.secrets/openrouter.gpg decrypts with the host keyring"
  else
    warn "$HOME/.secrets/openrouter.gpg present but does not decrypt with $HOME/.gnupg"
  fi
else
  warn "$HOME/.secrets/openrouter.gpg missing — paid stages will fail (see plan.md §4.4)"
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "All checks passed. Next: mise run up"
else
  echo "Some checks failed — see WARN lines above." >&2
  exit 1
fi
