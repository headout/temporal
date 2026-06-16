#!/bin/bash
# Skill Activation Prompt Hook
export CLAUDE_PPID="$PPID" HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" skill-activation-prompt-ho '{"result":"continue"}'
