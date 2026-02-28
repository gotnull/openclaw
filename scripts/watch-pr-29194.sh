#!/bin/bash
set -euo pipefail

PR_URL="https://github.com/openclaw/openclaw/pull/29194"
STATE_FILE="/tmp/openclaw-pr-29194-state"
LOG="/tmp/openclaw-pr-watch.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Checking PR #29194..." >> "$LOG"

STATUS=$(cd /Users/fulvio/development/openclaw && gh pr view 29194 --repo openclaw/openclaw --json state --jq '.state' 2>>"$LOG")

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Status: $STATUS" >> "$LOG"

PREV=$(cat "$STATE_FILE" 2>/dev/null || echo "UNKNOWN")

if [ "$STATUS" = "MERGED" ] && [ "$PREV" != "MERGED" ]; then
    echo "$STATUS" > "$STATE_FILE"
    osascript -e "display notification \"PR #29194 (browser url alias) has been merged! 🎉\" with title \"🐰 OpenClaw PR Accepted\" sound name \"Glass\""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] MERGED - notification sent" >> "$LOG"
    # Unload ourselves - job done
    launchctl unload ~/Library/LaunchAgents/com.gotnull.openclaw-pr-watch.plist 2>/dev/null || true
elif [ "$STATUS" = "CLOSED" ] && [ "$PREV" != "CLOSED" ]; then
    echo "$STATUS" > "$STATE_FILE"
    osascript -e "display notification \"PR #29194 was closed without merging 😞\" with title \"🐰 OpenClaw PR Closed\" sound name \"Basso\""
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] CLOSED - notification sent" >> "$LOG"
    launchctl unload ~/Library/LaunchAgents/com.gotnull.openclaw-pr-watch.plist 2>/dev/null || true
else
    echo "$STATUS" > "$STATE_FILE"
fi
