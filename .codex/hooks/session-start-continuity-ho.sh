#!/bin/bash
# Codex SessionStart equivalent — Codex has no SessionStart event, so we wire
# this to UserPromptSubmit and gate on a per-thread marker so it only runs
# once per CODEX_THREAD_ID.
# Codex hook output: empty stdout = continue, hookSpecificOutput for messages.
unset CLAUDE_PROJECT_DIR
export CLAUDE_PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export HOOK_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-$$}}" HOOK_AGENT="codex"

THREAD_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-}}"
if [ -z "$THREAD_ID" ]; then
  exit 0
fi

GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null)" || GIT_TOP=""
if [ -z "$GIT_TOP" ]; then
  exit 0
fi

MARKER_DIR="$GIT_TOP/.git/hac_telemetry"
MARKER_FILE="$MARKER_DIR/codex-thread-$THREAD_ID.bootstrapped"

# If marker exists, this thread already had its session-start fired. Skip.
if [ -f "$MARKER_FILE" ]; then
  exit 0
fi

mkdir -p "$MARKER_DIR" 2>/dev/null || true
: > "$MARKER_FILE" 2>/dev/null || true

# Pipe a synthetic SessionStart payload to the continuity handler.
echo '{"type":"start","source":"codex_user_prompt"}' | \
  "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" --silent session-start-continuity-ho
exit 0
