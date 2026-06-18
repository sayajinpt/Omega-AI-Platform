#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Omega — Native Linux build (WebKitGTK)"
node scripts/ensure-content-studio.mjs
node scripts/ensure-claw3d-office.mjs
npm run -w @omega/desktop ensure-engines

node scripts/generate-route-catalog.mjs
npm run build:shell
node scripts/package-native-linux.mjs
node scripts/package-appimage.mjs || echo "[build-linux-native] AppImage skipped (install appimagetool or run on Linux with FUSE)"

echo "OK: dist/native/Omega/"
