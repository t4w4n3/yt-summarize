#!/usr/bin/env bash
set -euo pipefail
# Sync the host GPG-encrypted OpenRouter key into a podman secret (tmpfs,
# rootless-friendly). Called by `mise run up` / `mise run setup` before
# `podman-compose up`.
# - openrouter_key: decrypted from ~/.secrets/openrouter.gpg + ~/.gnupg (ciphertext at rest)
# If the source does not exist, a dummy placeholder is created so that
# compose's `external: true` does not fail and the worker can still start
# (paid stages will fail with a clear credential error).

SECRET_OPENROUTER="openrouter_key"

sync_openrouter() {
  local gpg_file="$HOME/.secrets/openrouter.gpg"
  local gnupg_dir="$HOME/.gnupg"
  local tmp
  tmp="$(mktemp)"
  # cleanup even if we fail
  trap 'rm -f "$tmp"' RETURN

  # Sur VPS sans lecteur smartcard, gpg-agent loggue à chaque decrypt
  # "can't connect to .../scdaemon" (bruit journal). On le désactive
  # proprement — pas de YubiKey sur ce host.
  # INTENTIONAL: disable-scdaemon sans carte - réévaluer si YubiKey déployée
  if [ -d "$gnupg_dir" ] && ! grep -q "^disable-scdaemon" "$gnupg_dir/gpg-agent.conf" 2>/dev/null; then
    echo "disable-scdaemon" >>"$gnupg_dir/gpg-agent.conf"
    chmod 600 "$gnupg_dir/gpg-agent.conf" 2>/dev/null || true
    gpgconf --kill gpg-agent 2>/dev/null || true
  fi

  if [ -f "$gpg_file" ] && [ -d "$gnupg_dir" ]; then
    if GNUPGHOME="$gnupg_dir" gpg --quiet --batch --no-tty --decrypt "$gpg_file" >"$tmp" 2>/dev/null; then
      # validate it looks like an OpenRouter key
      if grep -q '^sk-or-' "$tmp"; then
        # extract last non-empty line (handle possible GPG armor headers)
        awk 'NF{line=$0} END{print line}' "$tmp" >"$tmp.key"
        mv "$tmp.key" "$tmp"
        if podman secret exists "$SECRET_OPENROUTER" >/dev/null 2>&1; then
          podman secret rm "$SECRET_OPENROUTER" >/dev/null
        fi
        podman secret create "$SECRET_OPENROUTER" "$tmp" >/dev/null
        echo "podman secret '$SECRET_OPENROUTER' synced from $gpg_file"
        rm -f "$tmp"
        trap - RETURN
        return 0
      else
        echo "WARNING: decrypted $gpg_file did not contain sk-or- key" >&2
      fi
    else
      echo "WARNING: could not decrypt $gpg_file with $gnupg_dir" >&2
    fi
  fi

  # fallback: no GPG or decrypt failed → placeholder
  if ! podman secret exists "$SECRET_OPENROUTER" >/dev/null 2>&1; then
    printf 'sk-or-missing-placeholder' | podman secret create "$SECRET_OPENROUTER" - >/dev/null
    echo "podman secret '$SECRET_OPENROUTER' created as placeholder (no valid GPG source)"
  else
    echo "podman secret '$SECRET_OPENROUTER' already exists (kept; no valid GPG source)"
  fi
  rm -f "$tmp"
  trap - RETURN
}

# main
sync_openrouter
