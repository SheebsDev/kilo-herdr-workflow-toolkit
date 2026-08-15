#!/usr/bin/env sh
set -eu

force=0
skip_dependencies=0
skip_checks=0
profile_path=""

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--force] [--skip-dependencies] [--skip-checks] [--profile PATH]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --force) force=1 ;;
    --skip-dependencies) skip_dependencies=1 ;;
    --skip-checks) skip_checks=1 ;;
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

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

if [ ! -f "$repository_root/plugin/workflow.ts" ]; then
  printf 'Workflow plugin not found at %s/plugin/workflow.ts\n' "$repository_root" >&2
  exit 1
fi

if [ -n "${KILO_CONFIG_DIR:-}" ] && [ "$KILO_CONFIG_DIR" != "$repository_root" ] && [ "$force" -ne 1 ]; then
  printf "KILO_CONFIG_DIR already points to '%s'. Re-run with --force only after deciding to replace that registration.\n" "$KILO_CONFIG_DIR" >&2
  exit 1
fi

existing_workflows=""
config_roots="$HOME/.config/kilo
$HOME/.kilo
$HOME/.kilocode"
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_roots="$config_roots
$XDG_CONFIG_HOME/kilo"
fi

old_ifs=$IFS
IFS='
'
for config_root in $config_roots; do
  [ "$config_root" = "$repository_root" ] && continue
  for plugin_directory in plugin plugins; do
    for extension in ts js; do
      candidate="$config_root/$plugin_directory/workflow.$extension"
      if [ -f "$candidate" ]; then
        existing_workflows="$existing_workflows
$candidate"
      fi
    done
  done
done
IFS=$old_ifs

if [ -n "$existing_workflows" ] && [ "$force" -ne 1 ]; then
  printf 'Existing workflow plugins would register duplicate tools:%s\n' "$existing_workflows" >&2
  exit 1
fi

if [ "$skip_dependencies" -ne 1 ]; then
  command -v npm >/dev/null 2>&1 || {
    printf 'npm was not found. Install Node.js 22.22.2 or newer, or use --skip-dependencies when appropriate.\n' >&2
    exit 1
  }
  (cd "$repository_root" && npm ci)
fi

if [ "$skip_checks" -ne 1 ]; then
  command -v npm >/dev/null 2>&1 || {
    printf 'npm was not found, so installation checks cannot run.\n' >&2
    exit 1
  }
  (cd "$repository_root" && npm test)
fi

if [ -z "$profile_path" ]; then
  case "${SHELL:-}" in
    */zsh) profile_path="$HOME/.zshrc" ;;
    */bash) profile_path="$HOME/.bashrc" ;;
    *) profile_path="$HOME/.profile" ;;
  esac
fi

profile_parent=$(dirname -- "$profile_path")
mkdir -p "$profile_parent"
touch "$profile_path"

start_marker='# >>> kilo-herdr-engineering-workflow >>>'
end_marker='# <<< kilo-herdr-engineering-workflow <<<'
temporary_profile=$(mktemp "${TMPDIR:-/tmp}/kilo-workflow-profile.XXXXXX")
trap 'rm -f "$temporary_profile"' EXIT HUP INT TERM

awk -v start="$start_marker" -v end="$end_marker" '
  $0 == start { skipping = 1; next }
  $0 == end { skipping = 0; next }
  !skipping { print }
' "$profile_path" > "$temporary_profile"

escaped_root=$(printf '%s' "$repository_root" | sed "s/'/'\\\\''/g")
{
  cat "$temporary_profile"
  printf '\n%s\n' "$start_marker"
  printf "export KILO_CONFIG_DIR='%s'\n" "$escaped_root"
  printf '%s\n' "$end_marker"
} > "$profile_path"

if ! command -v kilo >/dev/null 2>&1; then
  printf 'Warning: kilo is not currently on PATH. Install Kilo before using the workflow.\n' >&2
fi

if ! command -v herdr >/dev/null 2>&1; then
  printf 'Warning: herdr is not currently on PATH. The parallel workflow requires Herdr.\n' >&2
fi

printf 'KILO_CONFIG_DIR registered in %s: %s\n' "$profile_path" "$repository_root"
printf 'Start a new shell before launching Kilo from Herdr.\n'
