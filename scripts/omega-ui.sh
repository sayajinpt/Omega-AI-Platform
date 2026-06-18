#!/usr/bin/env bash
# Terminal UI helpers for Omega build scripts (source from build-linux.sh).

OMEGA_UI_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OMEGA_BANNER_FILE="${OMEGA_UI_ROOT}/apps/desktop/resources/omega-banner.txt"

if [[ -t 1 ]] && command -v tput >/dev/null 2>&1; then
  OMEGA_W=$(tput cols 2>/dev/null || echo 80)
else
  OMEGA_W=80
fi

OMEGA_CYN=$'\033[96m'
OMEGA_IND=$'\033[38;5;141m'
OMEGA_GRN=$'\033[92m'
OMEGA_YEL=$'\033[93m'
OMEGA_RED=$'\033[91m'
OMEGA_DIM=$'\033[2m'
OMEGA_BLD=$'\033[1m'
OMEGA_RST=$'\033[0m'

omega_clear() {
  printf '\033[2J\033[H' 2>/dev/null || true
}

omega_banner() {
  local title="${1:-}"
  omega_clear
  echo ""
  if [[ -f "$OMEGA_BANNER_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      printf '%b%s%b\n' "$OMEGA_IND" "$line" "$OMEGA_RST"
    done <"$OMEGA_BANNER_FILE"
  else
    printf '%b%b   Ωmega — Local AI Operating System%b\n' "$OMEGA_BLD" "$OMEGA_CYN" "$OMEGA_RST"
  fi
  echo ""
  if [[ -n "$title" ]]; then
    printf '%b%s%b\n' "$OMEGA_BLD" "$title" "$OMEGA_RST"
    printf '%b%s%b\n' "$OMEGA_DIM" "$(printf '%.0s─' {1..60})" "$OMEGA_RST"
    echo ""
  fi
}

omega_log() {
  local level="$1"
  shift
  local msg="$*"
  local prefix="[··]"
  local color="$OMEGA_DIM"
  case "$level" in
    ok) prefix="[ok]"; color="$OMEGA_GRN" ;;
    run) prefix="[>>]"; color="$OMEGA_CYN" ;;
    warn) prefix="[!!]"; color="$OMEGA_YEL" ;;
    err) prefix="[xx]"; color="$OMEGA_RED" ;;
    info) prefix="[··]"; color="$OMEGA_DIM" ;;
  esac
  printf '%b%s%b %s\n' "$color" "$prefix" "$OMEGA_RST" "$msg"
}

omega_step() {
  local cur="$1"
  local total="$2"
  shift 2
  local label="$*"
  echo ""
  printf '%b[%s/%s]%b %b%s%b\n' "$OMEGA_BLD" "$cur" "$total" "$OMEGA_RST" "$OMEGA_CYN" "$label" "$OMEGA_RST"
  omega_log run "starting…"
}

omega_progress_bar() {
  local pct="${1:-0}"
  local width=40
  local filled=$((pct * width / 100))
  local empty=$((width - filled))
  local bar=""
  local i
  for ((i = 0; i < filled; i++)); do bar+='█'; done
  for ((i = 0; i < empty; i++)); do bar+='░'; done
  printf '%b[%s] %3s%%%b\n' "$OMEGA_IND" "$bar" "$pct" "$OMEGA_RST"
}

omega_boot_sequence() {
  local mode="${1:-build}"
  omega_log info "kernel: omega-build-${mode}"
  sleep 0.08
  omega_log ok "terminal ui loaded"
  sleep 0.06
  omega_log ok "manifest: Omega local AI OS"
  sleep 0.05
}

omega_success() {
  echo ""
  omega_progress_bar 100
  printf '\n%b╔══════════════════════════════════════╗%b\n' "$OMEGA_GRN" "$OMEGA_RST"
  printf '%b║%b  %bBUILD SUCCEEDED%b%-22s%b║%b\n' "$OMEGA_GRN" "$OMEGA_RST" "$OMEGA_BLD" "$OMEGA_RST" "" "$OMEGA_GRN" "$OMEGA_RST"
  printf '%b╚══════════════════════════════════════╝%b\n\n' "$OMEGA_GRN" "$OMEGA_RST"
}

omega_fail() {
  echo ""
  printf '%b╔══════════════════════════════════════╗%b\n' "$OMEGA_RED" "$OMEGA_RST"
  printf '%b║%b  %bBUILD FAILED%b%-25s%b║%b\n' "$OMEGA_RED" "$OMEGA_RST" "$OMEGA_BLD" "$OMEGA_RST" "" "$OMEGA_RED" "$OMEGA_RST"
  printf '%b╚══════════════════════════════════════╝%b\n\n' "$OMEGA_RED" "$OMEGA_RST"
}
