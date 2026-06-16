#!/bin/bash
# Session Stop Telemetry Hook — aggregates session data, sends summary.
export CLAUDE_PPID="$PPID"
export HOOK_AGENT="claude" HOOK_SESSION_ID="${CLAUDE_SESSION_ID:-${CLAUDE_PPID}}"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" session-stop-telemetry-ho '{"result":"continue"}'
