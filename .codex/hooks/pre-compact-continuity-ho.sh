#!/bin/bash
# Codex pre-compact — save continuity ledger before context truncation. Codex: empty stdout = continue.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_AGENT="codex" HOOK_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-$$}}"
"$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" --silent pre-compact-continuity-ho
