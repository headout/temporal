#!/bin/bash
# Post-commit telemetry — reports AI vs human line stats. Async, non-blocking.

# Detect agent if not explicitly set.
# CLAUDE_PROJECT_DIR can leak into non-Claude shells, so check agent-specific
# env vars first to avoid misattributing commits.
if [ -z "$HOOK_AGENT" ]; then
  if [ -n "$CURSOR_CONVERSATION_ID" ]; then
    export HOOK_AGENT="cursor"
  elif [ -n "$CODEX_THREAD_ID" ] || [ -n "$CODEX_SESSION_ID" ]; then
    export HOOK_AGENT="codex"
  elif [ -n "$FACTORY_SESSION_ID" ]; then
    export HOOK_AGENT="factory"
  elif [ -n "$OPENCODE_SESSION_ID" ]; then
    export HOOK_AGENT="opencode"
  fi
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" --git-bg --no-stdin post-commit-telemetry-ho "$REPO_ROOT"
