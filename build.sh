#!/usr/bin/env bash
# Omega — one-click Linux installer build. On Windows use build.bat instead.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
case "$(uname -s)" in
  Linux*) ;;
  Darwin*)
    echo "On macOS, use: npm run build:mac (build.sh is for Linux)."
    exit 1
    ;;
  MINGW*|MSYS*|CYGWIN*|Windows*)
    echo "On Windows, use: build.bat"
    exit 1
    ;;
  *)
    echo "Unsupported OS for build.sh"
    exit 1
    ;;
esac
exec bash "${SCRIPT_DIR}/scripts/build-linux.sh"
