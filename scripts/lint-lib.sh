#!/usr/bin/env bash
# Shared file-collection helpers for the lint* mise tasks.
# Sourced by each task after `cd "$ROOT"`; never executed directly.

# Whether <path> belongs to lint kind <kind>.
# Kinds: js (JS/TS/JSON), sh (shell), yaml (non-compose YAML),
#        compose (compose YAML), containerfile (Containerfile/Dockerfile).
lint_kind_matches() { # lint_kind_matches <kind> <path>
  local kind=$1 path=$2 base
  base=$(basename "$path")
  case "$kind:$base" in
    js:*.js | js:*.mjs | js:*.cjs | js:*.jsx | js:*.ts | js:*.tsx | js:*.json | js:*.jsonc) return 0 ;;
    sh:*.sh) return 0 ;;
    yaml:*.yml | yaml:*.yaml)
      case "$base" in *compose*) return 1 ;; *) : ;; esac
      case "$path" in mise.lock | pnpm-lock.yaml) return 1 ;; *) : ;; esac
      return 0
      ;;
    compose:*.yml | compose:*.yaml)
      case "$base" in *compose*) return 0 ;; *) : ;; esac
      return 1
      ;;
    containerfile:[Cc]ontainerfile* | containerfile:[Dd]ockerfile*) return 0 ;;
    *) : ;;
  esac
  return 1
}

# List repo files belonging to <kind>, one path per line.
#   lint_list_files <kind>            → every tracked + untracked-but-not-ignored file
#   lint_list_files <kind> --changed  → uncommitted files only (staged + unstaged + untracked;
#                                       deletions excluded — nothing left to lint)
lint_list_files() { # lint_list_files <kind> [--changed]
  local kind=$1 mode=${2:-all} f
  if [ "$mode" = "--changed" ]; then
    {
      git diff --name-only HEAD --diff-filter=ACMR
      git ls-files --others --exclude-standard
    } | sort -u
  else
    git ls-files --cached --others --exclude-standard
  fi | while IFS= read -r f; do
    lint_kind_matches "$kind" "$f" && printf '%s\n' "$f"
  done
}
