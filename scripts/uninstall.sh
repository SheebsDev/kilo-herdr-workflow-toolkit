#!/usr/bin/env sh
set -eu

profile_path=""

usage() {
  cat <<'EOF'
Usage: ./scripts/uninstall.sh [--profile PATH]
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
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
