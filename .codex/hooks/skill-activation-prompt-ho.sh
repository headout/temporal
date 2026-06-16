#!/bin/bash
# Codex Skill Activation Prompt Hook. Codex: empty stdout = continue.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_SESSION_ID="${CODEX_THREAD_ID:-${CODEX_SESSION_ID:-$$}}" HOOK_AGENT="codex"
DISPATCH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks" && pwd)/hac-dispatch-ho.sh"
# Handler outputs hookSpecificOutput JSON when skills match, nothing otherwise.
OUT="$(cat | "$DISPATCH" skill-activation-prompt-ho '{}')"
# Only emit if handler produced hookSpecificOutput (not the bare fallback)
case "$OUT" in
  *hookSpecificOutput*) printf '%s\n' "$OUT" ;;
esac
