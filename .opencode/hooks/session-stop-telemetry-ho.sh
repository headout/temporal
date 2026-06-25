#!/bin/bash
# OpenCode session flush — Stop hook.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_AGENT="opencode" HOOK_SESSION_ID="${OPENCODE_SESSION_ID:-$$}"
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" session-stop-telemetry-ho '{"result":"continue"}'
