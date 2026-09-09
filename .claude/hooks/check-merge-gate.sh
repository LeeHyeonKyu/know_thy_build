#!/usr/bin/env bash
# know-thy-build merge gate — blocks git merge when feature gate is not fully passed

# Fast exit: only check commands that contain "git merge"
echo "${TOOL_INPUT:-}" | grep -qE 'git\s+merge' || exit 0

# Identify current feature from branch name (feature/NNN-slug)
BRANCH=$(git branch --show-current 2>/dev/null || echo "")
echo "$BRANCH" | grep -qE '^feature/' || exit 0

FEATURE_NUM=$(echo "$BRANCH" | grep -oE '[0-9]+' | head -1)
[ -z "$FEATURE_NUM" ] && exit 0

FEATURE_FILE="docs/features/$(printf '%03d' "$FEATURE_NUM").md"
[ -f "$FEATURE_FILE" ] || exit 0

# Skip completed features — their gate is historical, not active
grep -qE '^status:\s*complete' "$FEATURE_FILE" 2>/dev/null && exit 0

# Check gate statuses
PENDING=$(grep -cE '^\s+(architect|designer|qa):\s*pending' "$FEATURE_FILE" 2>/dev/null || echo "0")

if [ "$PENDING" -gt 0 ]; then
  echo "❌ Merge gate blocked — Feature $(printf '%03d' "$FEATURE_NUM") has pending reviews:"
  grep -E '^\s+(architect|designer|qa):' "$FEATURE_FILE" 2>/dev/null
  echo ""
  echo "Run /know-thy-build:finish to check gate status."
  exit 2
fi

exit 0
