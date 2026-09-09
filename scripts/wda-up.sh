#!/usr/bin/env bash
# Bring WebDriverAgent up on the connected iPhone and update WDA_BASE_URL in .env.
#
# Idempotent: if WDA already answers on the active address, exits immediately.
# Supports modern iOS (17+) with Xcode CoreDevice IPv6 tunnels and automatic provisioning.
#
# Usage:
#   bash scripts/wda-up.sh                 # build if needed, launch, wait for ready
#   FORCE_BUILD=1 bash scripts/wda-up.sh   # rebuild WDA first (after Xcode/iOS upgrades)
#   FORCE_RESTART=1 bash scripts/wda-up.sh # force-restart the test runner

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${IPHONE_MCP_WDA_PORT:-8100}"
DERIVED="$ROOT/.wda-build"
WDA_SRC="$ROOT/vendor/WebDriverAgent"
LOG="$DERIVED/wda-runner.log"

log() { printf '\033[36m[wda]\033[0m %s\n' "$*"; }
die() { printf '\033[31m[wda] %s\033[0m\n' "$*" >&2; exit 1; }

# Apple Developer Team ID used to sign WebDriverAgent
detect_team() {
  local dir="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  [ -d "$dir" ] || dir="$HOME/Library/MobileDevice/Provisioning Profiles"
  [ -d "$dir" ] || return 1
  local f
  for f in "$dir"/*.mobileprovision; do
    [ -e "$f" ] || continue
    security cms -D -i "$f" 2>/dev/null | plutil -extract TeamIdentifier.0 raw - 2>/dev/null
  done | sort | uniq -c | sort -rn | head -1 | awk '{print $2}'
}

# Modern iOS (17+) device detection via devicectl
detect_device_id() {
  xcrun devicectl list devices 2>/dev/null | awk '/connected/ {print $3}' | head -1
}

# CoreDevice IPv6 tunnel address
detect_coredevice_ip() {
  lsof -i -P -n 2>/dev/null | grep -i Xcode | grep -E -o "\->\[[0-9a-fA-F:]+\]" | sed "s/->\[//;s/\]//" | head -1
}

# Update or insert WDA_BASE_URL into .env
save_base_url() {
  local url="$1"
  local env_file="$ROOT/.env"
  if [ -f "$env_file" ]; then
    if grep -q "^WDA_BASE_URL=" "$env_file"; then
      sed -i '' "s|^WDA_BASE_URL=.*|WDA_BASE_URL=$url|" "$env_file"
    else
      echo "WDA_BASE_URL=$url" >> "$env_file"
    fi
  else
    echo "WDA_BASE_URL=$url" > "$env_file"
  fi
}

TEAM="${IPHONE_MCP_TEAM_ID:-$(detect_team || true)}"

# --- 0. already up? -----------------------------------------------------------
if [ -n "${FORCE_RESTART:-}" ]; then
  log "forcing runner restart"
  pkill -f "test-without-building" 2>/dev/null || true
  sleep 2
else
  # Check localhost first
  if curl -s -m 2 "http://127.0.0.1:${PORT}/status" 2>/dev/null | grep -q '"ready"[[:space:]]*:[[:space:]]*true'; then
    log "already up on http://127.0.0.1:${PORT}"
    save_base_url "http://127.0.0.1:${PORT}"
    exit 0
  fi
  # Check active CoreDevice IPv6 tunnel
  ACTIVE_IP="$(detect_coredevice_ip || true)"
  if [ -n "$ACTIVE_IP" ] && curl -s -m 2 "http://[${ACTIVE_IP}]:${PORT}/status" 2>/dev/null | grep -q '"ready"[[:space:]]*:[[:space:]]*true'; then
    log "already up on http://[${ACTIVE_IP}]:${PORT}"
    save_base_url "http://[${ACTIVE_IP}]:${PORT}"
    exit 0
  fi
fi

# --- 1. device ----------------------------------------------------------------
UDID="${IPHONE_MCP_UDID:-$(detect_device_id || true)}"
[ -n "$UDID" ] || die "no connected iPhone found. Plug it in and unlock it."
log "found device: $UDID"

command -v xcodebuild >/dev/null || die "xcodebuild missing — install Xcode"

# --- 2. build if needed -------------------------------------------------------
XCTESTRUN="$(ls "$DERIVED"/Build/Products/WebDriverAgentRunner_iphoneos*.xctestrun 2>/dev/null | head -1 || true)"
if [ -n "${FORCE_BUILD:-}" ] || [ -z "$XCTESTRUN" ]; then
  [ -d "$WDA_SRC" ] || die "WebDriverAgent source missing at $WDA_SRC — run: bash scripts/fetch-wda.sh"
  [ -n "$TEAM" ] || die "Could not determine an Apple Developer Team ID.
Set it explicitly: export IPHONE_MCP_TEAM_ID=XXXXXXXXXX
Find yours in Xcode > Settings > Accounts, or at developer.apple.com > Membership."

  log "building WebDriverAgent with team $TEAM (this may take a few minutes)..."
  mkdir -p "$DERIVED"
  ( cd "$WDA_SRC" && xcodebuild \
      -project WebDriverAgent.xcodeproj \
      -scheme WebDriverAgentRunner \
      -destination "id=$UDID" \
      -derivedDataPath "$DERIVED" \
      -allowProvisioningUpdates \
      DEVELOPMENT_TEAM="$TEAM" \
      CODE_SIGN_STYLE=Automatic \
      build-for-testing ) >"$DERIVED/build.log" 2>&1 \
    || die "build failed — see $DERIVED/build.log"
  XCTESTRUN="$(ls "$DERIVED"/Build/Products/WebDriverAgentRunner_iphoneos*.xctestrun | head -1)"
  log "build complete"
fi

# --- 3. launch the XCTest runner ---------------------------------------------
mkdir -p "$(dirname "$LOG")"
log "launching runner (log: $LOG)"
nohup xcodebuild test-without-building \
  -xctestrun "$XCTESTRUN" \
  -destination "id=$UDID" \
  -allowProvisioningUpdates >"$LOG" 2>&1 &

# --- 4. wait for ready --------------------------------------------------------
log "waiting for WebDriverAgent to report ready..."
for i in $(seq 1 45); do
  # Check localhost
  if curl -s -m 2 "http://127.0.0.1:${PORT}/status" 2>/dev/null | grep -q '"ready"[[:space:]]*:[[:space:]]*true'; then
    log "ready on http://127.0.0.1:${PORT}"
    save_base_url "http://127.0.0.1:${PORT}"
    exit 0
  fi
  # Check CoreDevice IPv6 tunnel
  ACTIVE_IP="$(detect_coredevice_ip || true)"
  if [ -n "$ACTIVE_IP" ] && curl -s -m 2 "http://[${ACTIVE_IP}]:${PORT}/status" 2>/dev/null | grep -q '"ready"[[:space:]]*:[[:space:]]*true'; then
    log "ready on http://[${ACTIVE_IP}]:${PORT}"
    save_base_url "http://[${ACTIVE_IP}]:${PORT}"
    exit 0
  fi
  sleep 2
done

die "WDA did not become ready in 90s. Last 20 lines of $LOG:
$(tail -20 "$LOG" 2>/dev/null)"

