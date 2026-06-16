#!/bin/bash
# Cursor AI Edit Tracking — supports preToolUse and postToolUse.
# HOOK_PHASE is set inline in hooks.json ("HOOK_PHASE=pre .cursor/hooks/track-ai-edits-ho.sh").
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_PHASE="${HOOK_PHASE:-post}" HOOK_SESSION_ID="${CURSOR_CONVERSATION_ID:-$$}" HOOK_AGENT="cursor" CURSOR_HOOK_ACTIVE=1
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" track-ai-edits-ho '{"result":"continue"}'
