#!/usr/bin/env sh
set -eu

force=0
skip_dependencies=0
skip_checks=0
profile_path=""
scope=global
project_path=""

usage() {
  cat <<'EOF'
Usage: ./scripts/install.sh [--scope global|project] [--project PATH] [--force] [--skip-dependencies] [--skip-checks] [--profile PATH]
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

if [ "$scope" = project ] && [ -z "$project_path" ]; then
  printf 'Project scope requires --project PATH.\n' >&2
  exit 2
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

config_roots="$HOME/.config/kilo
$HOME/.kilo
$HOME/.kilocode"
if [ -n "${XDG_CONFIG_HOME:-}" ]; then
  config_roots="$config_roots
$XDG_CONFIG_HOME/kilo"
fi

payload_paths_file=$(mktemp "${TMPDIR:-/tmp}/kilo-workflow-payload.XXXXXX")
project_staging_root=""
cleanup_project_files() {
  rm -f "$payload_paths_file"
  if [ -n "$project_staging_root" ]; then
    rm -rf "$project_staging_root"
  fi
}
trap cleanup_project_files EXIT HUP INT TERM

for payload_directory in command core launcher plugin skills; do
  if [ -d "$repository_root/$payload_directory" ]; then
    find "$repository_root/$payload_directory" -type f -print >> "$payload_paths_file"
  fi
done
for payload_file in package.json package-lock.json; do
  if [ -f "$repository_root/$payload_file" ]; then
    printf '%s/%s\n' "$repository_root" "$payload_file" >> "$payload_paths_file"
  fi
done

copy_payload() {
  source_root=$1
  destination_root=$2
  while IFS= read -r source_file; do
    relative_path=${source_file#"$repository_root/"}
    source_path="$source_root/$relative_path"
    destination_path="$destination_root/$relative_path"
    mkdir -p "$(dirname "$destination_path")"
    cp "$source_path" "$destination_path"
  done < "$payload_paths_file"
}

write_manifest() {
  manifest_path=$1
  manifest_root=$2
  manifest_output=$(mktemp "${TMPDIR:-/tmp}/kilo-workflow-manifest.XXXXXX")
  while IFS= read -r source_file; do
    relative_path=${source_file#"$repository_root/"}
    installed_path="$manifest_root/$relative_path"
    printf '%s\t%s\n' "$(file_hash "$installed_path")" "$relative_path" >> "$manifest_output"
  done < "$payload_paths_file"
  mv "$manifest_output" "$manifest_path"
}

if [ "$scope" = project ]; then
  if [ ! -d "$project_path" ]; then
    printf 'Project path is not a directory: %s\n' "$project_path" >&2
    exit 1
  fi

  project_root=$(CDPATH= cd -- "$project_path" && pwd)
  project_config_root="$project_root/.kilo"
  manifest_path="$project_config_root/kilo-herdr-engineering-workflow.manifest"

  existing_workflows=""
  global_roots="$config_roots
${KILO_CONFIG_DIR:-}
"
  old_ifs=$IFS
  IFS='
'
  for config_root in $global_roots; do
    [ -n "$config_root" ] || continue
    [ "$config_root" = "$project_config_root" ] && continue
    for plugin_directory in plugin plugins; do
      for extension in ts js; do
        candidate="$config_root/$plugin_directory/workflow.$extension"
        if [ -f "$candidate" ]; then
          existing_workflows="$existing_workflows\n$candidate"
        fi
      done
    done
  done
  IFS=$old_ifs

  if [ -z "$profile_path" ]; then
    case "${SHELL:-}" in
      */zsh) profile_path="$HOME/.zshrc" ;;
      */bash) profile_path="$HOME/.bashrc" ;;
      *) profile_path="$HOME/.profile" ;;
    esac
  fi
  if [ -f "$profile_path" ] && grep -F -q '# >>> kilo-herdr-engineering-workflow >>>' "$profile_path"; then
    existing_workflows="$existing_workflows\n$profile_path"
  fi

  if [ -n "$existing_workflows" ]; then
    printf 'Project installation would load duplicate workflow plugins:%b\n' "$existing_workflows" >&2
    printf 'Uninstall the global workflow first.\n' >&2
    exit 1
  fi

  mkdir -p "$project_config_root"
  if [ -d "$project_config_root/node_modules" ] && [ ! -f "$manifest_path" ]; then
    printf 'Project config directory already contains node_modules: %s\n' "$project_config_root" >&2
    printf 'Remove or migrate it before installing the workflow.\n' >&2
    exit 1
  fi

  while IFS= read -r source_file; do
    relative_path=${source_file#"$repository_root/"}
    destination_path="$project_config_root/$relative_path"
    if [ ! -f "$destination_path" ]; then
      continue
    fi

    owned_by_install=0
    if [ -f "$manifest_path" ] && awk -F '\t' -v path="$relative_path" '$2 == path { found = 1 } END { exit !found }' "$manifest_path"; then
      owned_by_install=1
    fi
    if [ "$owned_by_install" -eq 0 ] && [ "$force" -ne 1 ]; then
      printf 'Project file already exists: %s\n' "$destination_path" >&2
      printf 'Re-run with --force only after deciding to replace it.\n' >&2
      exit 1
    fi
    if [ "$owned_by_install" -eq 1 ] && [ "$force" -eq 0 ]; then
      installed_hash=$(file_hash "$destination_path")
      recorded_hash=$(awk -F '\t' -v path="$relative_path" '$2 == path { print $1; exit }' "$manifest_path")
      if [ "$installed_hash" != "$recorded_hash" ]; then
        printf 'Installed project file was modified: %s\n' "$destination_path" >&2
        printf 'Re-run with --force to replace it.\n' >&2
        exit 1
      fi
    fi
  done < "$payload_paths_file"

  if [ -f "$manifest_path" ]; then
    old_manifest_path=$(mktemp "${TMPDIR:-/tmp}/kilo-workflow-old-manifest.XXXXXX")
    cp "$manifest_path" "$old_manifest_path"
  else
    old_manifest_path=""
  fi

  project_staging_root=$(mktemp -d "${TMPDIR:-/tmp}/kilo-herdr-workflow.XXXXXX")
  copy_payload "$repository_root" "$project_staging_root"
  if [ "$skip_dependencies" -ne 1 ]; then
    command -v npm >/dev/null 2>&1 || {
      printf 'npm was not found. Install Node.js 22.22.2 or newer, or use --skip-dependencies when appropriate.\n' >&2
      exit 1
    }
    (cd "$project_staging_root" && npm ci)
  fi
  copy_payload "$repository_root" "$project_config_root"
  if [ "$skip_dependencies" -ne 1 ]; then
    cp -R "$project_staging_root/node_modules" "$project_config_root/"
  fi

  write_manifest "$manifest_path" "$project_config_root"
  if [ -n "$old_manifest_path" ]; then
    while IFS="$(printf '\t')" read -r old_hash old_relative_path; do
      is_managed_payload_path "$old_relative_path" || continue
      if awk -F '\t' -v path="$old_relative_path" '$2 == path { found = 1 } END { exit !found }' "$manifest_path"; then
        continue
      fi
      stale_path="$project_config_root/$old_relative_path"
      if [ -f "$stale_path" ] && [ "$(file_hash "$stale_path")" = "$old_hash" ]; then
        rm -f "$stale_path"
      fi
    done < "$old_manifest_path"
    rm -f "$old_manifest_path"
  fi

  if [ "$skip_dependencies" -eq 1 ]; then
    printf 'Warning: dependencies were skipped. The project installation requires @kilocode/plugin to be resolvable from the project config directory.\n' >&2
  fi
  printf 'Workflow installed for project: %s\n' "$project_root"
  printf 'Project Kilo configuration: %s\n' "$project_config_root"
  exit 0
fi

if [ -n "${KILO_CONFIG_DIR:-}" ] && [ "$KILO_CONFIG_DIR" != "$repository_root" ] && [ "$force" -ne 1 ]; then
  printf "KILO_CONFIG_DIR already points to '%s'. Re-run with --force only after deciding to replace that registration.\n" "$KILO_CONFIG_DIR" >&2
  exit 1
fi

existing_workflows=""

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

rm -f "$payload_paths_file"

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
