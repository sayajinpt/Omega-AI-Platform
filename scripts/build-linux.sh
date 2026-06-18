#!/usr/bin/env bash
# Omega — one-click Linux build (terminal UI + AppImage).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="${ROOT}/build-log.txt"
LOCK="${ROOT}/.omega/llama-setup.json"
cd "$ROOT"

# shellcheck source=omega-ui.sh
source "${ROOT}/scripts/omega-ui.sh"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    omega_fail
    omega_log err "$1 not found. $2"
    exit 1
  fi
}

get_primary_variant() {
  node -e "
const fs = require('fs');
const p = process.argv[1];
try {
  const lock = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (lock.primaryVariant) { console.log(lock.primaryVariant.trim()); process.exit(0); }
  const keys = Object.keys(lock.variants || {});
  if (keys.length === 1) { console.log(keys[0]); process.exit(0); }
  for (const v of ['linux-cuda', 'linux-vulkan', 'nvidia-vulkan-linux']) {
    if (keys.includes(v)) { console.log(v); process.exit(0); }
  }
  if (keys.length) console.log(keys[keys.length - 1]);
} catch (_) {}
" "$LOCK" 2>/dev/null || true
}

omega_banner "Ωmega — Linux build (one click)"
echo "  Log: ${LOG}"
echo "  You will choose llama.cpp version, prebuilt vs source, and NVIDIA or Vulkan."
echo ""
omega_boot_sequence linux

require node "Install Node.js 20+ (https://nodejs.org)"
omega_log ok "node $(node -v)"
require npm "npm ships with Node.js"
omega_log ok "npm ready"
require git "e.g. sudo apt install git"
omega_log ok "git ready"
require python3 "e.g. sudo apt install python3 python3-venv"
omega_log ok "python3 ready"
require unzip "e.g. sudo apt install unzip"
omega_log ok "unzip ready"

{
  echo "==== Omega Linux build $(date -Iseconds) ===="
} >"$LOG"

omega_step 1 3 "npm install"
omega_progress_bar 5
if ! npm install 2>&1 | tee -a "$LOG"; then
  omega_fail
  omega_log err "npm install failed — see ${LOG}"
  exit 1
fi
omega_log ok "dependencies installed"
omega_progress_bar 20

omega_step 2 3 "llama.cpp (version, prebuilt/source, GPU)"
omega_log info "Answer the prompts below (release tag, prebuilt/source, NVIDIA or Vulkan)"
omega_progress_bar 25
omega_log info "Latest llama.cpp prebuilt matrix (GitHub releases)"
node scripts/fetch-infer-binaries.mjs --catalog-only --installer 2>&1 | tee -a "$LOG" || true
echo ""
echo "---- llama-setup (interactive) ----" | tee -a "$LOG"
if ! node scripts/llama-setup.mjs --installer 2>&1 | tee -a "$LOG"; then
  omega_fail
  omega_log err "llama setup failed — see ${LOG}"
  exit 1
fi
echo "---- llama-setup done ----" | tee -a "$LOG"

VARIANT="$(get_primary_variant)"
if [ -n "${VARIANT}" ]; then
  export OMEGA_LLAMA_VARIANT="${VARIANT}"
  omega_log ok "GPU variant: ${OMEGA_LLAMA_VARIANT}"
else
  export OMEGA_LLAMA_VARIANT="linux-cuda"
  omega_log warn "No primary variant in lock — defaulting to ${OMEGA_LLAMA_VARIANT}"
fi
omega_progress_bar 45

omega_step 3 3 "Full production build (Content Studio, Claw3D, engines, AppImage)"
omega_log info "first run can take a long time (Claw3D clone + npm build)"
omega_progress_bar 50
if ! npm run build:linux 2>&1 | tee -a "$LOG"; then
  omega_fail
  omega_log err "build failed — see ${LOG}"
  exit 1
fi

omega_progress_bar 100
omega_success

OUT="${ROOT}/apps/desktop/dist/desktop"
omega_log ok "output folder: ${OUT}"
omega_log ok "llama GPU: ${OMEGA_LLAMA_VARIANT}"
if compgen -G "${OUT}/*.AppImage" >/dev/null 2>&1; then
  ls -lh "${OUT}"/*.AppImage
  omega_log ok "AppImage ready (chmod +x and run)"
elif compgen -G "${OUT}/*.deb" >/dev/null 2>&1; then
  ls -lh "${OUT}"/*.deb
else
  ls -la "${OUT}" 2>/dev/null || true
fi
echo ""
