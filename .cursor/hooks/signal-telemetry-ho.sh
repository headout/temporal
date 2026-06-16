#!/bin/bash
# Cursor Signal Telemetry — handles afterFileEdit and beforeShellExecution.
# HOOK_SIGNAL is set inline in hooks.json ("HOOK_SIGNAL=file_edit .cursor/hooks/signal-telemetry-ho.sh").
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${CURSOR_CONVERSATION_ID:-$$}" HOOK_AGENT="cursor" CURSOR_HOOK_ACTIVE=1
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" signal-telemetry-ho '{"result":"continue"}'
