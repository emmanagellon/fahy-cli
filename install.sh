#!/usr/bin/env bash
# fahy installer for macOS / Linux.
#
# Installs everything fahy needs, automatically:
#   1. Node.js 18+ (brew / apt via NodeSource / dnf / pacman).
#   2. mpv + yt-dlp (same package managers; skip with --skip-deps).
#   3. fahy globally via npm (GitHub channel by default; npm registry once published).
#   4. Runs `fahy --doctor` to prove the install.
#
#   curl -fsSL https://raw.githubusercontent.com/emmanagellon/fahy-cli/main/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --version latest --method source
set -euo pipefail

VERSION="latest"
METHOD="source"
SKIP_DEPS=0
DRY_RUN=0
REPO="emmanagellon/fahy-cli"
PKG="fahy-cli"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2;;
    --method) METHOD="$2"; shift 2;;
    --skip-deps) SKIP_DEPS=1; shift;;
    --dry-run) DRY_RUN=1; shift;;
    *) echo "Unknown option: $1" >&2; exit 1;;
  esac
done

step() { printf '\n== %s\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
dry() { [ "$DRY_RUN" -eq 1 ]; }

# Always 0 - safe under `set -e` even when node is missing.
node_major() {
  if ! have node; then echo 0; return 0; fi
  node --version | sed 's/^v//; s/\..*//'
}

# 1. Node.js ---------------------------------------------------------------
step "Checking Node.js"
if [ "$(node_major)" -ge 18 ]; then
  echo "Node.js $(node --version) ok ($(command -v node))"
elif [ "$SKIP_DEPS" -eq 1 ]; then
  echo "Node.js 18+ is required but not installed. Re-run without --skip-deps to auto-install it." >&2
  exit 1
else
  if dry; then
    echo "[dry-run] would install Node.js 18+ via system package manager"
  else
    echo "Installing Node.js..."
    if [ "$(uname)" = "Darwin" ]; then
      brew install node
    elif have apt-get; then
      # Distro repos lag (Ubuntu ships ancient node) - NodeSource tracks LTS.
      sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif have dnf; then
      sudo dnf install -y nodejs npm
    elif have pacman; then
      sudo pacman -S --noconfirm nodejs npm
    else
      echo "No supported package manager - install Node.js 18+ manually, then re-run." >&2
      exit 1
    fi
    hash -r 2>/dev/null || true
    if [ "$(node_major)" -lt 18 ]; then
      echo "Node.js 18+ still not on PATH. Open a new shell and re-run the installer." >&2
      exit 1
    fi
    echo "Node.js $(node --version) ok ($(command -v node))"
  fi
fi

# 2. Player + downloader ----------------------------------------------------
install_pkg() { # $1 = tool, $2 = brew, $3 = apt, $4 = dnf, $5 = pacman
  if have "$1"; then echo "$1 already installed."; return 0; fi
  if dry; then echo "[dry-run] would install $1 via system package manager"; return 0; fi
  echo "Installing $1..."
  if [ "$(uname)" = "Darwin" ]; then brew install "$2";
  elif have apt-get; then sudo apt-get install -y "$3";
  elif have dnf; then sudo dnf install -y "$4";
  elif have pacman; then sudo pacman -S --noconfirm "$5";
  else echo "No supported package manager for $1 - install it manually." >&2; return 1; fi
}
if [ "$SKIP_DEPS" -eq 1 ]; then
  echo "Skipping dependency install (--skip-deps)."
else
  step "Installing mpv + yt-dlp"
  install_pkg mpv mpv mpv mpv mpv || true
  install_pkg yt-dlp yt-dlp yt-dlp yt-dlp yt-dlp || true
fi

# 3. fahy itself -------------------------------------------------------------
if [ "$METHOD" = "npm" ]; then
  if [ "$VERSION" = "latest" ]; then SPEC="$PKG"; else SPEC="$PKG@$VERSION"; fi
else
  if [ "$VERSION" = "latest" ]; then REF=""; else REF="#$VERSION"; fi
  SPEC="github:$REPO$REF"
fi
step "Installing fahy ($METHOD: $SPEC)"
if dry; then
  echo "[dry-run] would run: npm install -g $SPEC"
  echo "[dry-run] then: fahy --doctor"
  exit 0
fi
# System-wide Node.js (apt/dnf) owns the global prefix - one sudo retry then.
if ! npm install -g "$SPEC"; then
  echo "Global install was denied - retrying with sudo..."
  sudo npm install -g "$SPEC"
fi

# 4. Verify ------------------------------------------------------------------
step "Verifying"
hash -r 2>/dev/null || true
fahy --doctor
echo ""
echo "Done. Try: fahy   (fullscreen shell)   or   fahy -m -S \"lofi\""
echo "Keep it current: fahy upgrade      Remove it: fahy uninstall"
