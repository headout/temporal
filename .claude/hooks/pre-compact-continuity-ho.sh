#!/bin/bash
# Pre-Compact Continuity Hook — creates auto-handoff before context compaction.
export HOOK_AGENT="claude"
exec "$(dirname "${BASH_SOURCE[0]}")/hac-dispatch-ho.sh" pre-compact-continuity-ho '{"continue":true}'
