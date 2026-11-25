// Healthcheck probe for the distroless `app` image (no shell, no curl).
// Run as: node /app/src/infrastructure/inbound/healthcheck.ts <url>
// Exits 0 when the URL answers 2xx, 1 otherwise. argv URL keeps the compose
// healthcheck in exec form: podman-compose >=1.5 serializes CMD arrays as JSON
// in --health-cmd, so no shell is involved (the old 1.3.0 mangled CMD into
// CMD-SHELL /bin/sh -c, which distroless cannot run).
const url = process.argv[2] ?? 'http://127.0.0.1:8080/';
try {
  const response = await fetch(url);
  process.exit(response.ok ? 0 : 1);
} catch {
  process.exit(1);
}
