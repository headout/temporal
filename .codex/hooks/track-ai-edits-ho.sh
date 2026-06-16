#!/bin/bash
# Codex AI Edit Tracking. Codex: empty stdout = continue.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_PHASE="${HOOK_PHASE:-post}" HOOK_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-$$}}" HOOK_AGENT="codex"
"$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" --silent track-ai-edits-ho
