#!/usr/bin/env bash
# Installs a macOS launchd agent so the Map Local static server starts at login
# and is restarted automatically if it ever dies. Folders to serve are pushed by
# the extension itself (options page → Save), nothing to configure here.
#
#   ./local-server/install-launchd.sh [--port <port>]
#   ./local-server/install-launchd.sh --uninstall
#
# Logs: ~/Library/Logs/devmode-serve.log

set -euo pipefail

LABEL="com.devmode.serve"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/devmode-serve.log"
PORT=4815

SCRIPT="$(cd "$(dirname "$0")" && pwd)/serve.js"
NODE="$(command -v node || true)"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
      rm -f "$PLIST"
      echo "Removed $LABEL"
      exit 0 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

[[ -n "$NODE" ]] || { echo "node not found in PATH"; exit 1; }

mkdir -p "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SCRIPT</string>
    <string>--port</string><string>$PORT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

# Replace any previous version and start it now
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "Installed $LABEL on http://127.0.0.1:$PORT"
echo "  log: $LOG"
echo "  uninstall: $0 --uninstall"
