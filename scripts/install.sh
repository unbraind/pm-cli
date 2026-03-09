#!/usr/bin/env bash
set -euo pipefail

PACKAGE_NAME="${PM_CLI_PACKAGE:-@unbrained/pm-cli}"
TARGET_VERSION="latest"
PREFIX=""

usage() {
  cat <<'EOF'
Install or update @unbrained/pm-cli globally via npm.

Usage:
  bash scripts/install.sh [--version <tag>] [--prefix <dir>]

Options:
  --version <tag>   Package tag/version to install (default: latest)
  --prefix <dir>    npm global prefix override
  -h, --help        Show this help message
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
}

is_literal_install_spec() {
  local name="$1"

  if [[ "$name" == file:* || "$name" == http://* || "$name" == https://* || "$name" == git+* || "$name" == npm:* ]]; then
    return 0
  fi

  if [[ "$name" == ./* || "$name" == ../* || "$name" == /* || "$name" == ~/* || "$name" == *.tgz || "$name" == *.tar.gz || "$name" == *\\* ]]; then
    return 0
  fi

  # Scoped names use @scope/pkg; only treat them as literal when explicitly versioned.
  if [[ "$name" == @*/*@* ]]; then
    return 0
  fi

  if [[ "$name" != @* && "$name" == *@* ]]; then
    return 0
  fi

  return 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      if [[ $# -lt 2 ]]; then
        echo "error: --version requires a value" >&2
        exit 2
      fi
      TARGET_VERSION="$2"
      shift 2
      ;;
    --prefix)
      if [[ $# -lt 2 ]]; then
        echo "error: --prefix requires a value" >&2
        exit 2
      fi
      PREFIX="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

require_command node
require_command npm

if is_literal_install_spec "$PACKAGE_NAME"; then
  INSTALL_SPEC="$PACKAGE_NAME"
else
  INSTALL_SPEC="${PACKAGE_NAME}@${TARGET_VERSION}"
fi
INSTALL_CMD=(npm install -g "$INSTALL_SPEC")
if [[ -n "$PREFIX" ]]; then
  INSTALL_CMD+=(--prefix "$PREFIX")
fi

echo "Installing ${INSTALL_SPEC}..."
"${INSTALL_CMD[@]}"

PM_BIN="pm"
if ! command -v "$PM_BIN" >/dev/null 2>&1; then
  if [[ -n "$PREFIX" && -x "${PREFIX}/bin/pm" ]]; then
    PM_BIN="${PREFIX}/bin/pm"
  else
    echo "error: pm binary not found on PATH after install." >&2
    if [[ -n "$PREFIX" ]]; then
      echo "hint: add ${PREFIX}/bin to your PATH or rerun without --prefix." >&2
    fi
    exit 1
  fi
fi

echo "Installed pm version: $($PM_BIN --version)"
echo "Done."
