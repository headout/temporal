#!/bin/bash
# Capture staged diff BEFORE linters run for AI line attribution
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
GIT_DIR_REL="$(git rev-parse --git-dir 2>/dev/null)" || exit 0
case "$GIT_DIR_REL" in
  /*) GIT_DIR_ABS="$GIT_DIR_REL" ;;
  *)  GIT_DIR_ABS="$REPO_ROOT/$GIT_DIR_REL" ;;
esac
HAC_DIR="$GIT_DIR_ABS/hac_telemetry"
mkdir -p "$HAC_DIR" || exit 0

# Skip silently if staged diff is huge (>10MB) to avoid blocking pre-commit on
# vendor drops, lockfile churn, generated assets, etc.
MAX_DIFF_BYTES=10485760
DIFF_BYTES="$(git diff --cached --unified=0 --no-color 2>/dev/null | wc -c | tr -d ' ')"
if [ -n "$DIFF_BYTES" ] && [ "$DIFF_BYTES" -gt "$MAX_DIFF_BYTES" ] 2>/dev/null; then
  exit 0
fi

git diff --cached --unified=0 --no-color > "$HAC_DIR/pre_lint_diff.patch" 2>/dev/null || true
date -u +%Y-%m-%dT%H:%M:%SZ > "$HAC_DIR/pre_lint_diff.timestamp" 2>/dev/null || true
