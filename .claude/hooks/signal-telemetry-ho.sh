#!/bin/bash
# Claude Signal Telemetry — handles shell_exec, mcp_exec, tool_failure, compaction signals.
# HOOK_SIGNAL is set inline in settings.json ("HOOK_SIGNAL=shell_exec ...").
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${CLAUDE_SESSION_ID:-${PPID:-$$}}" HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" signal-telemetry-ho '{"result":"continue"}'
