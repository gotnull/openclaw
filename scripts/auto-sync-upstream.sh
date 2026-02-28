#!/bin/bash
# Auto-sync fork with upstream (openclaw/openclaw)
# Skips if: dirty working tree, active branch isn't main, merge conflicts
set -euo pipefail

REPO="/Users/fulvio/development/openclaw"
LOG="/tmp/openclaw-sync.log"

cd "$REPO"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Sync check starting" >> "$LOG"

# Skip if not on main
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping: on branch '$BRANCH', not main" >> "$LOG"
    exit 0
fi

# Skip if working tree is dirty
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Skipping: uncommitted changes" >> "$LOG"
    exit 0
fi

# Fetch upstream
git fetch upstream --quiet 2>> "$LOG"

# Check if there's anything new
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse upstream/main)

if [ "$LOCAL" = "$REMOTE" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Already up-to-date" >> "$LOG"
    exit 0
fi

# Try merge (abort on conflict)
if git merge upstream/main --no-edit --quiet 2>> "$LOG"; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Merged upstream/main successfully" >> "$LOG"
    
    # Push to fork
    git push origin main --quiet 2>> "$LOG"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Pushed to origin/main" >> "$LOG"
    
    # Rebuild
    cd "$REPO" && pnpm build >> "$LOG" 2>&1
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Rebuilt from source" >> "$LOG"
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] Merge conflict! Aborting merge." >> "$LOG"
    git merge --abort
    exit 1
fi
