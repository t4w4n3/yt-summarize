#!/usr/bin/env bash
set -euo pipefail
# DNS regression gate for todo.md P2 (retirer `network_mode: "host"` du worker).
#
# The worker on a podman bridge network needs three things the host network
# used to give it for free:
#   1. external DNS + HTTPS (OpenRouter, direct) — via the network's embedded
#      DNS (aardvark-dns) forwarding to the host resolver;
#   2. resolving the `vpn` sidecar by service name (aardvark-dns) so yt-dlp
#      can reach the SOCKS5 proxy as `socks5h://vpn:1080`;
#   3. NOT reaching the host's own loopback (isolation: the app published on
#      127.0.0.1:8080 must be unreachable from the worker's own 127.0.0.1).
#
# On a host WITHOUT aardvark-dns, check 2 fails (ENOTFOUND) while 1 still
# works — that is exactly the breakage P2 must not ship silently. This script
# makes it loud: it exits non-zero with the failing check named.
#
# Usage: scripts/dns-regression.sh
#   Phase B (isolated network): external DNS/HTTPS + peer-name DNS +
#     loopback isolation, on a throwaway network + peer container.
#   Phase C (running stack, auto-detected): same probe on the compose network
#     against the real `vpn` container, including a SOCKS5 CONNECT to
#     www.youtube.com through the tunnel.
# Requires the worker image (`mise run build`); needs podman + internet.

IMAGE="localhost/summarize-yt_worker:latest"
NET="summarize-dns-regression"
PEER="dns-peer"
COMPOSE_NET="summarize-yt_default"
failures=0

if ! podman image exists "$IMAGE" >/dev/null 2>&1; then
  echo "FAIL: worker image $IMAGE missing — run: mise run build" >&2
  exit 2
fi

# aardvark-dns is what resolves container names on a bridge network. Report
# it up front: without it, the peer-name check below is expected to fail.
if [ -x /usr/lib/podman/aardvark-dns ]; then
  echo "aardvark-dns: present ($(podman info --format '{{.Host.NetworkBackend}}' 2>/dev/null || echo unknown) backend)"
else
  echo "WARN: aardvark-dns not found at /usr/lib/podman/aardvark-dns —" >&2
  echo "WARN: container-name resolution (checks 2/3) is expected to FAIL on this host." >&2
  echo "WARN: install aardvark-dns (ships with podman >= 4 + netavark) before dropping host networking." >&2
fi

cleanup() {
  podman rm -f "$PEER" >/dev/null 2>&1 || true
  podman network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Run the probe (python3 in the worker image) on a network: args are the
# peer name to resolve ("" = skip) and the SOCKS host ("" = skip).
probe() {
  local network="$1" peer_name="$2" socks_host="$3"
  timeout 120 podman run --rm -i --network "$network" --entrypoint "" "$IMAGE" \
    python3 - "$peer_name" "$socks_host" <<'PY'
import socket
import ssl
import sys

peer_name, socks_host = sys.argv[1], sys.argv[2]
failures = []

def check(name, fn):
    try:
        detail = fn()
        print(f"PASS: {name}" + (f" ({detail})" if detail else ""))
    except Exception as e:
        print(f"FAIL: {name}: {e}")
        failures.append(name)

def ext_dns():
    ip = socket.gethostbyname("openrouter.ai")
    return f"openrouter.ai -> {ip}"

def ext_https():
    ctx = ssl.create_default_context()
    with socket.create_connection(("openrouter.ai", 443), timeout=10) as s:
        with ctx.wrap_socket(s, server_hostname="openrouter.ai") as ss:
            ss.sendall(b"GET /api/v1/models HTTP/1.1\r\nHost: openrouter.ai\r\nConnection: close\r\n\r\n")
            return ss.recv(200).split(b"\r\n")[0].decode(errors="replace")

def peer_dns():
    ip = socket.gethostbyname(peer_name)
    return f"{peer_name} -> {ip}"

def isolation():
    try:
        socket.create_connection(("127.0.0.1", 8080), timeout=4).close()
    except ConnectionRefusedError:
        return "127.0.0.1:8080 refused from container loopback"
    raise AssertionError("127.0.0.1:8080 reachable — host loopback not isolated")

def socks_youtube():
    s = socket.create_connection((socks_host, 1080), timeout=10)
    s.settimeout(15)
    s.sendall(b"\x05\x01\x00")
    assert s.recv(2) == b"\x05\x00", "SOCKS greeting refused"
    hb = b"www.youtube.com"
    s.sendall(b"\x05\x01\x00\x03" + bytes([len(hb)]) + hb + (443).to_bytes(2, "big"))
    r = s.recv(4)
    assert r[0] == 5 and r[1] == 0, f"SOCKS CONNECT reply {r!r}"
    atyp = r[3]
    if atyp == 1:
        s.recv(6)
    elif atyp == 3:
        ln = s.recv(1)[0]
        s.recv(ln + 2)
    elif atyp == 4:
        s.recv(18)
    ctx = ssl.create_default_context()
    with ctx.wrap_socket(s, server_hostname="www.youtube.com") as ss:
        ss.sendall(b"GET / HTTP/1.1\r\nHost: www.youtube.com\r\nConnection: close\r\n\r\n")
        return ss.recv(200).split(b"\r\n")[0].decode(errors="replace")

check("external DNS (openrouter.ai)", ext_dns)
check("external HTTPS (openrouter.ai)", ext_https)
if peer_name:
    check(f"peer DNS ({peer_name})", peer_dns)
check("isolation (host loopback refused)", isolation)
if socks_host:
    check(f"SOCKS via {socks_host}:1080 (youtube)", socks_youtube)

sys.exit(1 if failures else 0)
PY
}

echo
echo "== Phase B: isolated bridge network =="
podman network create "$NET" >/dev/null 2>&1 || true
podman run -d --name "$PEER" --network "$NET" --entrypoint "" "$IMAGE" sleep 300 >/dev/null
if probe "$NET" "$PEER" ""; then
  echo "Phase B: all checks passed"
else
  echo "Phase B: FAILED (see FAIL lines above)" >&2
  failures=$((failures + 1))
fi

if podman ps --format '{{.Names}}' 2>/dev/null | grep -qx 'summarize-yt_vpn_1'; then
  echo
  echo "== Phase C: running stack (compose network, real vpn SOCKS) =="
  if probe "$COMPOSE_NET" "vpn" "vpn"; then
    echo "Phase C: all checks passed"
  else
    echo "Phase C: FAILED (see FAIL lines above)" >&2
    failures=$((failures + 1))
  fi
else
  echo
  echo "Phase C: skipped (summarize-yt_vpn_1 not running — start the stack for the SOCKS check)"
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "DNS regression: PASS — bridge DNS, peer resolution and isolation all hold"
else
  echo "DNS regression: FAIL ($failures phase(s) failing) — do not drop network_mode: host until fixed" >&2
  exit 1
fi
