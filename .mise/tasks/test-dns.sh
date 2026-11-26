#!/usr/bin/env bash
set -euo pipefail
#MISE description="DNS regression gate (P2): bridge DNS + vpn SOCKS + loopback isolation"
#MISE alias="td"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
source "$ROOT/scripts/metrics.sh"
metrics_start "test-dns" "$@"
trap 'metrics_end $?' EXIT

exec bash "$ROOT/scripts/dns-regression.sh"
