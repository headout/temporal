#!/bin/bash
# Codex notify hook (agent-turn-complete) — Codex passes one JSON argument.
export CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
export HOOK_AGENT="codex"
# Default arg to a literal empty JSON object when Codex omits it. The previous
# `${1:-{\}}` form was malformed bash and produced a junk literal.
arg="${1:-{}}"
exec "$(dirname "${BASH_SOURCE[0]}")/../../.claude/hooks/hac-dispatch-ho.sh" --git --no-stdin codex-notify-ho "$arg"
