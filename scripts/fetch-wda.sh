#!/usr/bin/env bash
# Fetch the WebDriverAgent source that gets built and installed onto the phone.
# Kept in vendor/ (gitignored) rather than vendored into this repo — it's a large
# upstream Xcode project with its own release cadence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/WebDriverAgent"
REPO="${WDA_REPO:-https://github.com/appium/WebDriverAgent.git}"

if [ -d "$DEST/.git" ]; then
  echo "[wda] already present at $DEST"
  echo "[wda] $(git -C "$DEST" log -1 --format='%h %s')"
  exit 0
fi

mkdir -p "$ROOT/vendor"
echo "[wda] cloning $REPO (shallow)..."
git clone --depth 1 "$REPO" "$DEST"
echo "[wda] successfully cloned to $DEST"
echo "[wda] $(git -C "$DEST" log -1 --format='%h %s')"
echo "[wda] next: bash scripts/wda-up.sh"

