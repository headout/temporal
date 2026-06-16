#!/bin/bash
# Session Start Continuity Hook — loads continuity ledger on resume/compact/clear.
export HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" session-start-continuity-ho '{"result":"continue"}'
