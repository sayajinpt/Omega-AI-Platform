#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "Omega — Native macOS build (WKWebView)"
node scripts/ensure-content-studio.mjs
node scripts/ensure-claw3d-office.mjs
npm run -w @omega/desktop ensure-engines

node scripts/generate-route-catalog.mjs
npm run build:shell
node scripts/package-native-mac.mjs
node scripts/package-dmg.mjs || echo "[build-macos-native] DMG skipped"

echo "OK: dist/native/Omega.app"
