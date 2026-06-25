#!/bin/bash
# Agent Call Tracking Hook — tracks Task tool invocations (agent spawns).
export CLAUDE_PPID="$PPID"
export HOOK_SESSION_ID="${CLAUDE_PPID:-$$}" HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" track-agent-calls-ho '{"result":"continue"}'
