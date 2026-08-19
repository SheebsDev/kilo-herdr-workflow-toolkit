#!/usr/bin/env sh
set -eu

profile_path=""
scope=global
project_path=""

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--scope global|project] [--project PATH] [--profile PATH]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --scope)
      shift
      [ "$#" -gt 0 ] || { usage >&2; exit 2; }
      case "$1" in
        global|project) scope=$1 ;;
        *) usage >&2; exit 2 ;;
      esac
      ;;
    --project)
      shift
      [ "$#" -gt 0 ] || { usage >&2; exit 2; }
      project_path=$1
      ;;
    --profile)
      shift
      [ "$#" -gt 0 ] || { usage >&2; exit 2; }
      profile_path=$1
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$scope" = project ]; then
  if [ -z "$project_path" ]; then
    printf 'Project scope requires --project PATH.\n' >&2
    exit 2
  fi
  if [ ! -d "$project_path" ]; then
    printf 'Project path is not a directory: %s\n' "$project_path" >&2
    exit 1
  fi

  project_root=$(CDPATH= cd -- "$project_path" && pwd)
  project_config_root="$project_root/.kilo"
  manifest_path="$project_config_root/kilo-herdr-engineering-workflow.manifest"
  if [ ! -f "$manifest_path" ]; then
    printf 'No project workflow installation exists for: %s\n' "$project_root"
    exit 0
  fi

  file_hash() {
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "$1" | awk '{print tolower($1)}'
    else
      shasum -a 256 "$1" | awk '{print tolower($1)}'
    fi
  }

  is_managed_payload_path() {
    case "$1" in
      package.json|package-lock.json|command/*|core/*|launcher/*|plugin/*|skills/*) return 0 ;;
      *) return 1 ;;
    esac
  }

  while IFS="$(printf '\t')" read -r recorded_hash relative_path; do
    [ -n "$recorded_hash" ] || continue
    [ -n "$relative_path" ] || continue
    is_managed_payload_path "$relative_path" || continue
    installed_path="$project_config_root/$relative_path"
    if [ ! -f "$installed_path" ]; then
      continue
    fi
    if [ "$(file_hash "$installed_path")" = "$(printf '%s' "$recorded_hash" | tr '[:upper:]' '[:lower:]')" ]; then
      rm -f "$installed_path"
    else
      printf 'Warning: leaving modified project file in place: %s\n' "$installed_path" >&2
    fi
  done < "$manifest_path"

  rm -f "$manifest_path"
  printf 'Removed the project workflow installation from: %s\n' "$project_root"
  printf 'Existing project Kilo configuration and dependencies were left in place.\n'
  exit 0
fi

if [ -z "$profile_path" ]; then
  case "${SHELL:-}" in
    */zsh) profile_path="$HOME/.zshrc" ;;
    */bash) profile_path="$HOME/.bashrc" ;;
    *) profile_path="$HOME/.profile" ;;
  esac
fi

if [ ! -f "$profile_path" ]; then
  printf 'Profile does not exist; nothing changed: %s\n' "$profile_path"
  exit 0
fi

start_marker='# >>> kilo-herdr-engineering-workflow >>>'
end_marker='# <<< kilo-herdr-engineering-workflow <<<'
temporary_profile=$(mktemp "${TMPDIR:-/tmp}/kilo-workflow-profile.XXXXXX")
trap 'rm -f "$temporary_profile"' EXIT HUP INT TERM

awk -v start="$start_marker" -v end="$end_marker" '
  $0 == start { skipping = 1; found = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
  END { if (!found) exit 3 }
' "$profile_path" > "$temporary_profile" || status=$?

status=${status:-0}
if [ "$status" -eq 3 ]; then
  printf 'No workflow registration was found in %s.\n' "$profile_path"
  exit 0
fi
if [ "$status" -ne 0 ]; then
  exit "$status"
fi

cat "$temporary_profile" > "$profile_path"
printf 'Removed the workflow registration from %s.\n' "$profile_path"
printf 'The repository and all existing Kilo configuration were left in place.\n'
