#!/bin/bash
# OpenCode Signal Telemetry — handles file_edit and shell_exec signals.
# HOOK_SIGNAL is set inline in settings.json ("HOOK_SIGNAL=file_edit ...").
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${OPENCODE_SESSION_ID:-$$}" HOOK_AGENT="opencode"
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" signal-telemetry-ho '{"result":"continue"}'
