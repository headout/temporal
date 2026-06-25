#!/bin/bash
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${CURSOR_CONVERSATION_ID:-$$}" HOOK_AGENT="cursor" CURSOR_HOOK_ACTIVE=1
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" track-agent-calls-ho '{"result":"continue"}'
