#!/bin/bash
# Unified hook dispatcher for HeadoutAgentsConfig telemetry/continuity hooks.
#
# Usage:
#   hac-dispatch-ho.sh <handler-name> [<fallback-json>]
#   hac-dispatch-ho.sh --git <handler-name> [extra args...]
#   hac-dispatch-ho.sh --git-bg <handler-name> [extra args...]   # detached background
#   hac-dispatch-ho.sh --no-stdin <handler-name> [args...]       # do not pipe stdin
#   hac-dispatch-ho.sh --silent <handler-name> [args...]         # discard stdout
#
# Resolution order:
#   1. <project>/.claude/hooks/dist/<handler>.mjs
#         where project = $CLAUDE_PROJECT_DIR or $FACTORY_PROJECT_DIR
#         or auto-detected as <script-dir>/../.. (works for .cursor/.factory/.codex/.opencode)
#   2. $HOME/.claude/hooks/dist/<handler>.mjs
#
# Always exits 0; telemetry must never block.

MODE="json"            # json | json-bg | git | git-bg | silent
PIPE_STDIN=1

while [ $# -gt 0 ]; do
  case "$1" in
    --git)      MODE="git";    shift;;
    --git-bg)   MODE="git-bg"; shift;;
    --json-bg)  MODE="json-bg"; shift;;
    --silent)   MODE="silent"; shift;;
    --no-stdin) PIPE_STDIN=0;  shift;;
    --) shift; break;;
    -*)
      # Unknown flag; treat as terminator to be forgiving.
      break;;
    *)  break;;
  esac
done

HANDLER="$1"; shift || true
FALLBACK="${1:-}"
# If first remaining arg looks like JSON, consume as fallback (json mode only).
if [ "$MODE" = "json" ] && [ -n "$FALLBACK" ] && [ "${FALLBACK#\{}" != "$FALLBACK" ]; then
  shift
else
  FALLBACK=""
fi
[ -z "$FALLBACK" ] && FALLBACK='{"result":"continue"}'

if [ -z "$HANDLER" ]; then
  case "$MODE" in
    git|git-bg|silent) exit 0;;
    *) echo "$FALLBACK"; exit 0;;
  esac
fi

emit_fallback() {
  case "$MODE" in
    git|git-bg|silent) :;;
    *) echo "$FALLBACK";;
  esac
  exit 0
}

# json-bg: respond immediately with the fallback (Claude expects a result),
# then fire the handler detached in the background. Use this for Claude hooks
# whose result is decorative (Notification, SubagentStop, SessionEnd).

command -v node >/dev/null 2>&1 || emit_fallback

# Determine project dir
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd 2>/dev/null)" || SCRIPT_DIR=""
PROJECT_DIR=""
if [ -n "$CLAUDE_PROJECT_DIR" ]; then
  PROJECT_DIR="$CLAUDE_PROJECT_DIR"
elif [ -n "$FACTORY_PROJECT_DIR" ]; then
  PROJECT_DIR="$FACTORY_PROJECT_DIR"
elif [ -n "$SCRIPT_DIR" ]; then
  # If the dispatcher is invoked from <project>/.claude/hooks/, then ../..
  # gives the project root. For peer-agent wrappers that exec into us, the
  # dispatcher itself still lives under .claude/hooks, so this is correct.
  PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd 2>/dev/null)" || PROJECT_DIR=""
fi

# Also try git toplevel as a fallback (for git hooks invoked outside an agent env)
if [ -z "$PROJECT_DIR" ] || [ ! -f "$PROJECT_DIR/.claude/hooks/dist/$HANDLER.mjs" ]; then
  GIT_TOP="$(git rev-parse --show-toplevel 2>/dev/null)"
  if [ -n "$GIT_TOP" ] && [ -f "$GIT_TOP/.claude/hooks/dist/$HANDLER.mjs" ]; then
    PROJECT_DIR="$GIT_TOP"
  fi
fi

# Worktree fallback: --show-toplevel returns the worktree path which won't have
# dist/. The main repo's .git lives at git-common-dir; its parent is the main
# checkout where dist/ is checked in.
if [ -z "$PROJECT_DIR" ] || [ ! -f "$PROJECT_DIR/.claude/hooks/dist/$HANDLER.mjs" ]; then
  GIT_COMMON="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [ -n "$GIT_COMMON" ]; then
    # Resolve to absolute path; .git -> repo root is its parent.
    GIT_COMMON_ABS="$(cd "$GIT_COMMON" 2>/dev/null && pwd)" || GIT_COMMON_ABS=""
    if [ -n "$GIT_COMMON_ABS" ]; then
      MAIN_TOP="$(dirname "$GIT_COMMON_ABS")"
      if [ -f "$MAIN_TOP/.claude/hooks/dist/$HANDLER.mjs" ]; then
        PROJECT_DIR="$MAIN_TOP"
      fi
    fi
  fi
fi

# Resolve handler path
HANDLER_PATH=""
HANDLER_DIR=""
if [ -n "$PROJECT_DIR" ] && [ -f "$PROJECT_DIR/.claude/hooks/dist/$HANDLER.mjs" ]; then
  HANDLER_DIR="$PROJECT_DIR/.claude/hooks"
  HANDLER_PATH="$HANDLER_DIR/dist/$HANDLER.mjs"
elif [ -f "$HOME/.claude/hooks/dist/$HANDLER.mjs" ]; then
  HANDLER_DIR="$HOME/.claude/hooks"
  HANDLER_PATH="$HANDLER_DIR/dist/$HANDLER.mjs"
fi

[ -z "$HANDLER_PATH" ] && emit_fallback

# Check dist freshness: warn if .ts source is newer than .mjs dist
SRC_FILE="$HANDLER_DIR/src/$HANDLER.ts"
if [ -f "$SRC_FILE" ] && [ "$SRC_FILE" -nt "$HANDLER_PATH" ]; then
  echo "[HAC WARNING] dist/$HANDLER.mjs is older than src/$HANDLER.ts — run build" >&2
fi

cd "$HANDLER_DIR" 2>/dev/null || true

# When HAC_DEBUG_HOOKS is set, capture stderr to a debug log instead of /dev/null
# so hook errors are recoverable.
if [ -n "$HAC_DEBUG_HOOKS" ]; then
  STDERR_SINK="/tmp/hac-hook-errors.log"
else
  STDERR_SINK="/dev/null"
fi

case "$MODE" in
  json-bg)
    # Emit Claude's fallback synchronously, then run the handler in the
    # background so the hook returns instantly. Move the `cat` of stdin
    # *into* the backgrounded subshell so the wrapper exits immediately
    # after echoing the fallback — otherwise `cat > $STDIN_CACHE` blocks
    # until the parent closes our stdin pipe, defeating json-bg.
    echo "$FALLBACK"
    if [ "$PIPE_STDIN" = "1" ] && [ ! -t 0 ]; then
      (
        STDIN_CACHE="$(mktemp)"
        cat > "$STDIN_CACHE"
        node "$HANDLER_PATH" "$@" < "$STDIN_CACHE" >/dev/null 2>>"$STDERR_SINK"
        rm -f "$STDIN_CACHE"
      ) &
      disown 2>/dev/null || true
    else
      ( node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" </dev/null & )
    fi
    exit 0
    ;;
  git-bg)
    if [ "$PIPE_STDIN" = "1" ] && [ ! -t 0 ]; then
      STDIN_CACHE="$(mktemp)"
      cat > "$STDIN_CACHE"
      ( node "$HANDLER_PATH" "$@" < "$STDIN_CACHE" >/dev/null 2>>"$STDERR_SINK"; rm -f "$STDIN_CACHE" ) &
      disown 2>/dev/null || true
    else
      ( node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" </dev/null & )
    fi
    exit 0
    ;;
  git)
    if [ "$PIPE_STDIN" = "1" ]; then
      cat | node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" || true
    else
      node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" || true
    fi
    exit 0
    ;;
  silent)
    if [ "$PIPE_STDIN" = "1" ]; then
      cat | node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" || true
    else
      node "$HANDLER_PATH" "$@" >/dev/null 2>>"$STDERR_SINK" || true
    fi
    exit 0
    ;;
  json|*)
    # Capture stdout: if node exits 0 but produces nothing, Claude treats the
    # hook as failed. Always emit the fallback when stdout is empty.
    OUT=""
    if [ "$PIPE_STDIN" = "1" ]; then
      OUT="$(cat | node "$HANDLER_PATH" "$@" 2>>"$STDERR_SINK")" || OUT=""
    else
      OUT="$(node "$HANDLER_PATH" "$@" 2>>"$STDERR_SINK")" || OUT=""
    fi
    if [ -z "$OUT" ]; then
      echo "$FALLBACK"
    else
      printf '%s\n' "$OUT"
    fi
    exit 0
    ;;
esac
