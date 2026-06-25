---
name: harden-pr
description: "Hardens an open pull request through repeated review-and-fix cycles, surfacing edge cases, error handling, and safety gaps and applying fixes before merge. Use when the user wants to harden, strengthen, or improve a PR/pull request, especially a large or risky one."
allowed-tools: [Bash, Read, Write, Edit, Glob, Grep, Agent, AskUserQuestion]
---

# Harden PR

Iterative PR hardening via recall-precision loop: wide review, skeptical evaluation, minimal fixes, re-review.

## When to Use

- Large/risky PR needing deeper pass before merge
- PR under active review; pre-fix issues
- Multi-lens review needed (code quality, error handling, simplification, tests, types)

## Inputs

- **PR identifier** (required): PR number or GitHub URL
- **Max loops** (optional, default `3`): `--max-loops N`
- **Aspects** (optional, default `code errors simplify`): `--aspects "code errors simplify tests comments types"`

Aspect-to-reviewer mapping:

| Aspect | Reviewer |
|--------|----------|
| `code` | code-reviewer |
| `errors` | silent-failure-hunter |
| `simplify` | code-simplifier |
| `tests` | pr-test-analyzer |
| `comments` | comment-analyzer |
| `types` | type-design-analyzer |

Infer repo from `git remote get-url origin` if not in PR URL.

## Bundled Reviewers

6 read-only reviewer agents in `reviewers/`, forked from Anthropic's [pr-review-toolkit](https://github.com/anthropics/claude-code/tree/main/plugins/pr-review-toolkit). Each restricted to `allowed-tools: [Read, Glob, Grep]` — read-only, never edit. Only the fixer (Step 5) has write access.

| Reviewer | File |
|----------|------|
| code-reviewer | `reviewers/code-reviewer.md` |
| silent-failure-hunter | `reviewers/silent-failure-hunter.md` |
| code-simplifier | `reviewers/code-simplifier.md` |
| pr-test-analyzer | `reviewers/pr-test-analyzer.md` |
| comment-analyzer | `reviewers/comment-analyzer.md` |
| type-design-analyzer | `reviewers/type-design-analyzer.md` |

## Phase 1: Gather PR Context

Before touching branches:
- If workspace dirty/shared, create isolated worktree first
- Fetch PR metadata via `gh pr view`, diff via `gh pr diff`, inline/issue comments via `gh api`
- Save diff to `/tmp/harden-pr-{PR_NUMBER}-diff.txt` — point all reviewers here
- Write compact context to `/tmp/harden-pr-{PR_NUMBER}-context.md`:
  - PR title and description
  - Existing review comments (inline and top-level)
  - Changed files with change type (added/modified/deleted)
  - Base and head branch names

## The Loop

```
for iteration in 1..max_loops:
    1. DECOMPOSE (loop 1 only)
    2. REVIEW SWARM (parallel)
    3. EVALUATE
    4. CONVERGE?
    5. FIX
    6. REPORT
```

### Step 1: Decompose (Loop 1 Only)

Split PR into logical chunks, assign review lenses per chunk.

Chunking: semantic (files by feature), layered (models vs handlers vs tests), or single-file (one file dominates risk). Small PRs (<=5 files): one chunk.

Lens assignment:
- Always include `code-reviewer`
- `silent-failure-hunter` for error handling, fallbacks, retries, null-handling
- `code-simplifier` when code grew more complex/branchy
- `pr-test-analyzer` when behavior or tests changed
- `comment-analyzer` when docs/comments changed
- `type-design-analyzer` when models, schemas, or types changed

Loops 2+: skip decomposition, review only files changed by previous fixer pass.

### Step 2: Review Swarm (Parallel)

Spawn one agent per (chunk, lens) pair. Load reviewer `.md` from `reviewers/` as agent prompt. Reviewers are read-only — must NOT use Edit, Write, or Bash. They report findings only; fixes happen in Step 5. Each reviewer gets:
- Review ONLY these files: `{CHUNK_FILES}`
- PR diff at `/tmp/harden-pr-{PR_NUMBER}-diff.txt` — read only relevant sections
- Focus on issues **introduced or worsened** by this PR
- Call out pre-existing issues separately; do not rate them Critical/Important
- Do not revert unrelated edits

Also spawn one cross-cutting reviewer using prompt in `references/agent-prompts.md` for contract mismatches, inconsistent patterns, incomplete multi-file changes.

Loops 2+: append prior-loop context from `references/agent-prompts.md`, focus on regressions.

### Step 3: Evaluate

Spawn one evaluator agent using prompt in `references/agent-prompts.md`.

Evaluator aggregates, deduplicates, verifies findings against actual code. Rejects false positives, YAGNI suggestions, out-of-scope items. Downgrades inflated severities. Decides if another fix cycle is worthwhile.

### Step 4: Convergence Check

| Condition | Action |
|-----------|--------|
| Fixer changed code last iteration | Continue — re-review |
| No validated Critical/Important issues | Stop |
| Evaluator says not worth it | Stop |
| Fixer made no changes | Stop |
| Max iterations reached | Stop |

### Step 5: Fix

Spawn one fixer agent using prompt in `references/agent-prompts.md`. Fix only validated issues with minimal safe changes. Run formatter/linter/tests after. Stage only PR-scoped files and commit with `fix: harden-pr loop {N} - {summary}`.

### Step 6: Report

Print: `Loop {N}: Swarm found X issues across {A} reviewers, evaluator validated Y and rejected Z. {Continuing / Stopping because...}`

## Final Report

```
## Harden PR #{PR_NUMBER} — Final Report
Loops: {N} of {max} | Reason stopped: {reason}
Issues found: {total} | Validated: {V} | Fixed: {F} | Rejected: {R}
Commits: {list}
Remaining: {unfixed items}
Recommendation: {Push / Squash / Review remaining manually}
```

## References

- `reviewers/*.md` — read-only reviewer agents (`allowed-tools: [Read, Glob, Grep]`)
- `references/agent-prompts.md` — cross-cutting reviewer, evaluator, fixer, and prior-loop context prompts
