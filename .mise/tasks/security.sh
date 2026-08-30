#!/usr/bin/env bash
set -euo pipefail
#MISE description="Run every security static analysis: pnpm audit, Trivy (vulns/secrets/misconfig), Gitleaks (worktree + git history)"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

status=0

echo "── pnpm audit --audit-level=low (dependency advisories)"
pnpm audit --audit-level=low || status=1

echo "── trivy fs (vulns + secrets + misconfig, all severities)"
# --ignore-unfixed: vulnerabilities without a published fix would make the gate permanently red.
# --skip-dirs: artefacts gitignorés (e2e traces, stryker, dev data) — évite un race
# test-e2e ↔ trivy quand hk lance tout en parallèle (stat sur fichier en cours de delete).
trivy fs \
  --scanners vuln,misconfig,secret \
  --severity UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL \
  --exit-code 1 \
  --ignore-unfixed \
  --skip-dirs test-results \
  --skip-dirs .stryker-tmp \
  --skip-dirs .local \
  --skip-dirs e2e/.tmp \
  --skip-dirs playwright-report \
  . || status=1

echo "── gitleaks dir (secrets in the working tree)"
gitleaks dir --no-banner "$ROOT" || status=1

echo "── gitleaks git (secrets in commit history)"
gitleaks git --no-banner "$ROOT" || status=1

if [ "$status" -ne 0 ]; then
  echo "security FAILED (see output above)" >&2
  exit 1
fi
echo "all security checks passed"
