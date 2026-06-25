#!/bin/bash
# HeadoutAgentsConfig telemetry bootstrap.
# Idempotent. Run once after cloning a vendored repo (or invoked automatically by
# AI-agent SessionStart hooks). Wires .git/hooks/* and merges Factory hooks into
# ~/.factory/settings.json so post-commit telemetry + Droid hooks fire on a fresh
# clone with no install step.
#
# Soft-fail: bootstrap must never throw a non-zero exit on missing prerequisites.
# We always touch the marker so SessionStart doesn't loop on every session.

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKER_FILE="$REPO_ROOT/.git/.hac_bootstrapped"
FORCE=0
[ "$1" = "--force" ] && FORCE=1

# Ensure marker is touched on exit so we don't keep retrying on each SessionStart.
_touch_marker() {
  if [ -d "$REPO_ROOT/.git" ]; then
    touch "$MARKER_FILE" 2>/dev/null || true
  fi
}
trap _touch_marker EXIT

# Resolve the directory Git actually uses for hooks. Honor core.hooksPath
# (Husky sets `.husky/_`; users can also point to other dirs). Falls back to
# .git/hooks. Mirrors getConfiguredGitHookPath() in telemetry-core-ho.ts.
# Defined above the fast-exit so the drift check can call it.
_resolve_git_hooks_dir() {
  local cfg
  cfg="$(git -C "$REPO_ROOT" config --get core.hooksPath 2>/dev/null)"
  if [ -z "$cfg" ]; then
    echo "$REPO_ROOT/.git/hooks"
    return
  fi
  # Husky v9: `.husky/_` -> user scripts live in `.husky/`
  local norm="${cfg%/}"
  case "$norm" in
    *.husky/_)
      echo "$REPO_ROOT/.husky"
      return
      ;;
  esac
  if [ "${norm#/}" != "$norm" ]; then
    echo "$norm"
  else
    echo "$REPO_ROOT/$norm"
  fi
}

# ---- Git hooks ----
# NOTE: this literal MUST stay byte-identical to GIT_TELEMETRY_MARKER in
# telemetry-core-ho.ts (the TS self-heal). A mismatch makes the drift check
# below false-positive and reinstall every session. Asserted in smoke tests.
TELEMETRY_MARKER="# === HeadoutAgentsConfig Telemetry ==="
TELEMETRY_END="# === End Telemetry ==="

# Single source of truth for the git hooks that carry $TELEMETRY_MARKER (installed
# by _install_hook below). Reused by the fast-exit drift check AND the install
# section — a new telemetry hook only needs adding here plus its _install_hook
# line. (pre-commit/prepare-commit-msg use their own markers and are checked
# separately; they're not in this list.)
TELEMETRY_HOOKS="post-commit post-checkout post-rewrite post-merge"

# Fast exit if already bootstrapped this clone (unless --force) — BUT only when
# ALL our telemetry hook blocks are still present where git currently looks for
# hooks. If husky/lefthook flipped core.hooksPath after bootstrap, or a newer
# release added a hook that an old clone never installed (e.g. post-merge), the
# installed set is incomplete; fall through to a full reinstall in that case.
# Installs are idempotent (_install_hook strips its old block before re-adding),
# so re-running the install section on an already-bootstrapped clone is safe.
if [ "$FORCE" -eq 0 ] && [ -f "$MARKER_FILE" ]; then
  _hooks_dir="$(_resolve_git_hooks_dir)"
  _all_present=1
  for _h in $TELEMETRY_HOOKS; do
    if [ ! -f "$_hooks_dir/$_h" ] || ! grep -q "$TELEMETRY_MARKER" "$_hooks_dir/$_h" 2>/dev/null; then
      _all_present=0
      break
    fi
  done
  if [ "$_all_present" -eq 1 ]; then
    exit 0
  fi
  # hooksPath drifted, a hook was stripped, or a new telemetry hook is missing —
  # reinstall below.
fi

# Must be a git repo
if [ ! -d "$REPO_ROOT/.git" ]; then
  echo "[hac-bootstrap] not a git repo: $REPO_ROOT — skipping" >&2
  exit 0
fi

HOOKS_DIST="$REPO_ROOT/.claude/hooks/dist"
if [ ! -d "$HOOKS_DIST" ]; then
  echo "[hac-bootstrap] missing $HOOKS_DIST — vendor .claude/ or run install.sh first; skipping" >&2
  exit 0
fi

GIT_HOOKS_DIR="$(_resolve_git_hooks_dir)"

_strip_block() {
  local f="$1"
  [ -f "$f" ] && grep -q "$TELEMETRY_MARKER" "$f" || return 0
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "/$TELEMETRY_MARKER/,/$TELEMETRY_END/d" "$f"
  else
    sed -i "/$TELEMETRY_MARKER/,/$TELEMETRY_END/d" "$f"
  fi
}

_install_hook() {
  local hook_file="$1" handler="$2" invoke="$3"
  _strip_block "$hook_file"
  mkdir -p "$(dirname "$hook_file")"
  [ -f "$hook_file" ] || echo '#!/bin/bash' > "$hook_file"
  # Ensure the existing hook ends with a newline before appending our block,
  # else the marker glues onto the last command and corrupts the user's hook.
  [ -s "$hook_file" ] && [ -n "$(tail -c1 "$hook_file")" ] && echo >> "$hook_file"
  cat >> "$hook_file" << HOOK_EOF
$TELEMETRY_MARKER
(
  REPO_ROOT="\$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
  for dir in "\$REPO_ROOT/.claude/hooks/dist" "\$HOME/.claude/hooks/dist"; do
    if [ -f "\$dir/${handler}" ]; then
      ${invoke}
      break
    fi
  done
) &
$TELEMETRY_END
HOOK_EOF
  chmod +x "$hook_file"
}

# pre-commit pre-lint snapshot is PREPENDED (not appended) so it runs BEFORE linters
# reformat staged files. Markers must match telemetry-core-ho.ts so the runtime
# self-healer recognizes our block and doesn't double-write.
PRELINT_MARKER="# BEGIN_HAC_PRE_LINT_SNAPSHOT"
PRELINT_END="# END_HAC_PRE_LINT_SNAPSHOT"

_install_prelint() {
  local hook_file="$1"
  # Idempotent: skip if marker already present.
  if [ -f "$hook_file" ] && grep -q "$PRELINT_MARKER" "$hook_file"; then
    return 0
  fi

  mkdir -p "$(dirname "$hook_file")"

  local existing=""
  [ -f "$hook_file" ] && existing="$(cat "$hook_file")"

  local shebang="#!/bin/bash"
  local rest=""
  if [ -n "$existing" ]; then
    if [[ "$existing" == "#!"* ]]; then
      shebang="$(printf '%s\n' "$existing" | head -n 1)"
      rest="$(printf '%s\n' "$existing" | tail -n +2)"
    else
      rest="$existing"
    fi
  fi

  {
    echo "$shebang"
    echo "$PRELINT_MARKER"
    echo '('
    echo '  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0'
    echo '  for dir in "$REPO_ROOT/.claude/hooks" "$HOME/.claude/hooks"; do'
    echo '    if [ -f "$dir/pre-lint-snapshot-ho.sh" ]; then'
    echo '      bash "$dir/pre-lint-snapshot-ho.sh"'
    echo '      break'
    echo '    fi'
    echo '  done'
    echo ')'
    echo "$PRELINT_END"
    [ -n "$rest" ] && printf '%s\n' "$rest"
  } > "$hook_file"
  chmod +x "$hook_file"
}

# prepare-commit-msg bootstrap is PREPENDED so it self-heals post-commit /
# pre-commit hooks before any AI session runs. Markers must match
# telemetry-core-ho.ts (GIT_BOOTSTRAP_MARKER) so the runtime self-healer
# recognizes our block and doesn't double-write. The block invokes
# skill-activation-prompt-ho.mjs as a lightweight trigger so telemetry-core's
# git-hook installer self-heals on each commit.
BOOTSTRAP_MARKER="# BEGIN_HAC_BOOTSTRAP"
BOOTSTRAP_END="# END_HAC_BOOTSTRAP"

_install_bootstrap() {
  local hook_file="$1"
  # Idempotent: skip if marker already present.
  if [ -f "$hook_file" ] && grep -q "$BOOTSTRAP_MARKER" "$hook_file"; then
    return 0
  fi

  mkdir -p "$(dirname "$hook_file")"

  local existing=""
  [ -f "$hook_file" ] && existing="$(cat "$hook_file")"

  local shebang="#!/bin/bash"
  local rest=""
  if [ -n "$existing" ]; then
    if [[ "$existing" == "#!"* ]]; then
      shebang="$(printf '%s\n' "$existing" | head -n 1)"
      rest="$(printf '%s\n' "$existing" | tail -n +2)"
    else
      rest="$existing"
    fi
  fi

  {
    echo "$shebang"
    echo "$BOOTSTRAP_MARKER"
    echo '# Telemetry bootstrap — ensures post-commit/pre-commit hooks are installed'
    echo 'REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || true'
    echo 'for dir in "$REPO_ROOT/.claude/hooks/dist" "$HOME/.claude/hooks/dist"; do'
    echo '  if [ -f "$dir/skill-activation-prompt-ho.mjs" ]; then'
    echo "    echo '{\"prompt\":\"\",\"session_id\":\"bootstrap\"}' | node \"\$dir/skill-activation-prompt-ho.mjs\" >/dev/null 2>&1 &"
    echo '    break'
    echo '  fi'
    echo 'done'
    echo "$BOOTSTRAP_END"
    [ -n "$rest" ] && printf '%s\n' "$rest"
  } > "$hook_file"
  chmod +x "$hook_file"
}

# Install into the directory Git actually invokes (honors core.hooksPath / Husky).
_install_hook      "$GIT_HOOKS_DIR/post-commit"        "post-commit-telemetry-ho.mjs"   'node "$dir/post-commit-telemetry-ho.mjs" "$REPO_ROOT" &'
_install_hook      "$GIT_HOOKS_DIR/post-checkout"      "post-checkout-telemetry-ho.mjs" 'node "$dir/post-checkout-telemetry-ho.mjs" "$1" "$2" "$3" &'
_install_hook      "$GIT_HOOKS_DIR/post-rewrite"       "post-rewrite-telemetry-ho.mjs"  'cat | node "$dir/post-rewrite-telemetry-ho.mjs" "$REPO_ROOT" &'
_install_hook      "$GIT_HOOKS_DIR/post-merge"         "post-merge-telemetry-ho.mjs"    'node "$dir/post-merge-telemetry-ho.mjs" "$REPO_ROOT" &'
_install_prelint   "$GIT_HOOKS_DIR/pre-commit"
_install_bootstrap "$GIT_HOOKS_DIR/prepare-commit-msg"

# .husky/ (Husky-managed repos override .git/hooks via core.hooksPath).
# Also install into .husky/ if present and we didn't already target it.
if [ -d "$REPO_ROOT/.husky" ] && [ "$GIT_HOOKS_DIR" != "$REPO_ROOT/.husky" ]; then
  _install_hook      "$REPO_ROOT/.husky/post-commit"        "post-commit-telemetry-ho.mjs"   'node "$dir/post-commit-telemetry-ho.mjs" "$REPO_ROOT" &'
  _install_hook      "$REPO_ROOT/.husky/post-checkout"      "post-checkout-telemetry-ho.mjs" 'node "$dir/post-checkout-telemetry-ho.mjs" "$1" "$2" "$3" &'
  _install_hook      "$REPO_ROOT/.husky/post-rewrite"       "post-rewrite-telemetry-ho.mjs"  'cat | node "$dir/post-rewrite-telemetry-ho.mjs" "$REPO_ROOT" &'
  _install_hook      "$REPO_ROOT/.husky/post-merge"         "post-merge-telemetry-ho.mjs"    'node "$dir/post-merge-telemetry-ho.mjs" "$REPO_ROOT" &'
  _install_prelint   "$REPO_ROOT/.husky/pre-commit"
  _install_bootstrap "$REPO_ROOT/.husky/prepare-commit-msg"
fi

# ---- Factory user-settings merge ----
# Droid only loads ~/.factory/settings.json; project .factory/settings.json is ignored.
# Merge with absolute paths, idempotent (strips prior entries scoped to THIS repo).
_install_factory() {
  local proj="$REPO_ROOT/.factory/settings.json"
  local user="$HOME/.factory/settings.json"
  [ -f "$proj" ] || return 0
  command -v jq &>/dev/null || { echo "[hac-bootstrap] jq missing; skip Factory merge" >&2; return 0; }
  mkdir -p "$HOME/.factory"
  [ -f "$user" ] || echo '{}' > "$user"

  local overlay merged
  overlay=$(mktemp); merged=$(mktemp)

  jq --arg dir "$REPO_ROOT" '
    if (.hooks // empty) then
      .hooks |= (to_entries | map(.value |= map(
        if .hooks then
          .hooks |= map(if .command then .command |= gsub("\\$FACTORY_PROJECT_DIR"; $dir) else . end)
        else . end
      )) | from_entries)
    else . end
  ' "$proj" > "$overlay" 2>/dev/null || { rm -f "$overlay" "$merged"; return 1; }

  local pat
  pat=$(printf '%s' "$REPO_ROOT/.factory/hooks/" | sed 's/[][\.\*^$()+?{}|/]/\\&/g')

  jq --argjson overlay "$(cat "$overlay")" --arg pattern "$pat" '
    . as $user |
    ($overlay | del(.hooks)) as $base |
    ($user * $base) |
    if ($overlay | has("hooks")) then
      .hooks = (
        ($user.hooks // {}) as $uh |
        ($overlay.hooks // {}) as $oh |
        $uh |
        reduce ($oh | to_entries[]) as $e (
          .;
          ((.[$e.key] // []) | map(
            if type == "object" and .hooks then
              .hooks = [.hooks[] | select(.command | test($pattern) | not)]
              | select(.hooks | length > 0)
            elif type == "object" and .command then
              select(.command | test($pattern) | not)
            else . end
          )) as $cleaned |
          .[$e.key] = ($cleaned + $e.value)
        )
      )
    else . end
  ' "$user" > "$merged" 2>/dev/null && mv "$merged" "$user" || { rm -f "$overlay" "$merged"; return 1; }
  rm -f "$overlay"
  return 0
}

_install_factory && echo "[hac-bootstrap] Factory hooks merged into ~/.factory/settings.json" >&2

# Marker is touched in trap _touch_marker on exit.
echo "[hac-bootstrap] git hooks installed at: $GIT_HOOKS_DIR" >&2
exit 0
