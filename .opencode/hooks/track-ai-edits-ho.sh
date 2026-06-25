#!/bin/bash
# OpenCode AI Edit Tracking.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_PHASE="${HOOK_PHASE:-post}" HOOK_SESSION_ID="${OPENCODE_SESSION_ID:-$$}" HOOK_AGENT="opencode"
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" track-ai-edits-ho '{"result":"continue"}'
