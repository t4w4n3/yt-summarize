#!/usr/bin/env bash
set -euo pipefail
# Sync host GPG-encrypted secrets into podman secrets (tmpfs, rootless-friendly).
# Called by `mise run up` / `mise run setup` before `podman-compose up`.
# - openrouter_key: decrypted from ~/.secrets/openrouter.gpg + ~/.gnupg (ciphertext at rest)
# - youtube_cookies: from ~/.secrets/youtube-cookies.txt (if present)
# If the source does not exist, a dummy placeholder is created so that
# compose's `external: true` does not fail and the worker can still start
# (it will warn and paid stages will fail with a clear credential error).

SECRET_OPENROUTER="openrouter_key"
SECRET_COOKIES="youtube_cookies"

ensure_secret() {
  local name="$1" file="$2" placeholder="$3"
  if [ -f "$file" ]; then
    if [ -s "$file" ]; then
      if podman secret exists "$name" >/dev/null 2>&1; then
        podman secret rm "$name" >/dev/null
      fi
      podman secret create "$name" "$file" >/dev/null
      echo "podman secret '$name' synced from $file"
      return 0
    fi
  fi
  # source missing or empty → ensure a dummy placeholder so compose doesn't error
  if ! podman secret exists "$name" >/dev/null 2>&1; then
    printf '%s' "$placeholder" | podman secret create "$name" - >/dev/null
    echo "podman secret '$name' created as placeholder (no source at $file)"
  else
    echo "podman secret '$name' already exists (placeholder kept; source missing at $file)"
  fi
}

sync_openrouter() {
  local gpg_file="$HOME/.secrets/openrouter.gpg"
  local gnupg_dir="$HOME/.gnupg"
  local tmp
  tmp="$(mktemp)"
  # cleanup even if we fail
  trap 'rm -f "$tmp"' RETURN

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

sync_cookies() {
  local cookie_file="$HOME/.secrets/youtube-cookies.txt"
  # podman secret create needs a file; we create a dummy if missing
  if [ -f "$cookie_file" ] && [ -s "$cookie_file" ]; then
    ensure_secret "$SECRET_COOKIES" "$cookie_file" "# empty - no cookies"
  else
    # ensure dummy exists so compose external doesn't fail
    if ! podman secret exists "$SECRET_COOKIES" >/dev/null 2>&1; then
      printf '# empty - no cookies\n' | podman secret create "$SECRET_COOKIES" - >/dev/null
      echo "podman secret '$SECRET_COOKIES' created as placeholder (no $cookie_file)"
    else
      echo "podman secret '$SECRET_COOKIES' already exists (placeholder kept)"
    fi
  fi
}

# main
sync_openrouter
sync_cookies
