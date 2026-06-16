#!/bin/bash
# AI Edit Tracking Hook — pre/post file edits for AI code attribution.
export CLAUDE_PPID="$PPID"
export HOOK_PHASE="${HOOK_PHASE:-post}" HOOK_SESSION_ID="${CLAUDE_PPID:-$$}" HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" track-ai-edits-ho '{"result":"continue"}'
