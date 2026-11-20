#!/usr/bin/env bash
# AXCLONER launcher — Linux / macOS / Termux
# by axyers team (mikey)

set -euo pipefail

cd "$(dirname "$0")"

BOLD=$'\033[1m'
DIM=$'\033[2m'
AMBER=$'\033[38;5;214m'
RED=$'\033[31m'
RESET=$'\033[0m'

say() { printf '%s\n' "$*"; }
die() { printf '%s%s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

say "${AMBER}${BOLD}AXCLONER${RESET} ${DIM}by axyers team (mikey)${RESET}"

# --- node check ------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  say ""
  say "${RED}node is not installed.${RESET}"
  say ""
  if [ -n "${PREFIX:-}" ] && [ -d "${PREFIX:-}/etc" ] && printf '%s' "$PREFIX" | grep -qi termux; then
    say "Termux:"
    say "  pkg update && pkg install nodejs-lts"
  elif [ "$(uname -s)" = "Darwin" ]; then
    say "macOS:"
    say "  brew install node"
    say "  # or grab the installer from https://nodejs.org"
  else
    say "Ubuntu / Debian:"
    say "  sudo apt update && sudo apt install -y nodejs npm"
    say "  # if that node is older than 18:"
    say "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    say "  sudo apt install -y nodejs"
  fi
  say ""
  die "install node 18 or newer, then run this again."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  say ""
  say "${RED}node $(node -v) is too old.${RESET} Version 18.17 or newer is required."
  say ""
  say "Ubuntu / Debian:"
  say "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
  say "  sudo apt install -y nodejs"
  say ""
  die "upgrade node and run this again."
fi

# --- port ------------------------------------------------------------------
PORT="${PORT:-4080}"

port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

if port_busy; then
  say ""
  say "${AMBER}port ${PORT} is busy.${RESET}"
  say "Another AXCLONER is probably still running."
  say ""
  read -r -p "Kill whatever is on ${PORT} and continue? [y/N] " answer || answer=""
  case "$answer" in
    y|Y|yes|YES)
      if command -v fuser >/dev/null 2>&1; then
        fuser -k "${PORT}/tcp" >/dev/null 2>&1 || true
      elif command -v lsof >/dev/null 2>&1; then
        lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs -r kill >/dev/null 2>&1 || true
      fi
      sleep 0.6
      port_busy && die "port ${PORT} is still taken — close it and retry."
      ;;
    *)
      say ""
      say "Set a different port and run again:"
      say "  PORT=4081 ./axcloner.sh"
      exit 0
      ;;
  esac
fi

# --- open the browser once the server answers ------------------------------
open_browser() {
  local url="http://localhost:${PORT}"
  for _ in $(seq 1 40); do
    if command -v curl >/dev/null 2>&1; then
      curl -sf -o /dev/null "$url/api/info" && break
    else
      sleep 0.25
      break
    fi
    sleep 0.25
  done

  if [ -n "${PREFIX:-}" ] && [ -d "${PREFIX:-}/bin" ] && [ -x "${PREFIX}/bin/termux-open-url" ]; then
    termux-open-url "$url" >/dev/null 2>&1 || true
  elif [ "$(uname -s)" = "Darwin" ]; then
    open "$url" >/dev/null 2>&1 || true
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 || true
  fi
}
open_browser &
BROWSER_PID=$!
disown "$BROWSER_PID" 2>/dev/null || true

say "${DIM}node $(node -v) · port ${PORT}${RESET}"
say ""

export PORT
exec node server.js
