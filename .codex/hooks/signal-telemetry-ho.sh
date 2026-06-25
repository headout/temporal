#!/bin/bash
# Codex Signal Telemetry — handles shell_exec, mcp_exec, tool_failure, compaction.
# HOOK_SIGNAL is set inline in hooks.json. Codex convention: empty stdout = continue.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-$$}}" HOOK_AGENT="codex"
"$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" --silent signal-telemetry-ho
