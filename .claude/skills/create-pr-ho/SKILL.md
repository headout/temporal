---
name: create-pr
description: "Pushes the current branch and opens a GitHub pull request with a structured summary and test plan. Use when the user wants to create, open, make, raise, or submit a PR/pull request, or says \"ready for review\". Not for rewriting an existing PR's description (use pr-describe)."
---

# Create PR

Create GitHub PR from current branch with structured description from commits, context, and optional plan/spec files.

## When to Use

- After `/commit` or `/implement-plan`
- User says "create pr", "open pr", "make pr", "raise pr", "submit pr"

## Prerequisites

- `gh` CLI installed and authenticated
- Commits ahead of base branch
- Clean working directory

## Invocation

```
/create-pr [base-branch]
```

- **base-branch** (optional): Target branch (default: auto-detect `main`/`master`)

## Workflow

### Step 1: Validate State

```bash
# Check gh auth
gh auth status

# Check for uncommitted changes
git status --porcelain

# Get current branch
git branch --show-current
```

**Fail conditions:**
- `gh auth status` fails → tell user to run `gh auth login`
- Dirty working directory → suggest `/commit` first
- On `main`/`master` → tell user to create feature branch

### Step 2: Determine Base Branch and Diff

```bash
# Fetch latest from base branch (faster than fetching all branches)
git fetch origin main 2>/dev/null || git fetch origin master 2>/dev/null

# Detect base branch
git ls-remote --heads origin main
git ls-remote --heads origin master
```

Use `main` if exists, else `master`. If neither, ask user.

```bash
# Commits on this branch not in base (ensure base is fetched first)
git log origin/<base>..HEAD --oneline

# Full diff summary
git diff origin/<base>..HEAD --stat

# Full diff for analysis
git diff origin/<base>..HEAD
```

No commits ahead → stop and inform user.

### Step 3: Check Remote Branch

```bash
# Check if branch is already pushed
git ls-remote --heads origin "$(git branch --show-current)"
```

### Step 4: Analyze Changes

Review commit history and diff:
1. **What changed** — files modified/added/deleted
2. **Why** — derive from commits and context
3. **Type** — feature, bugfix, refactor, docs, chore
4. **Risk areas** — large diffs, config changes, dependency updates, migrations

Check `thoughts/shared/plans/` for recent plan files for additional context.

### Step 5: Draft PR Content

#### Title Format
```
<type>: <concise summary under 70 chars>
```
Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`, `perf`

#### Body Format

```markdown
## Summary
<2-5 bullet points describing what and WHY>

## Changes
<Grouped list of notable changes by area>

## Test Plan
- [ ] <Test step 1>
- [ ] <Test step 2>
- [ ] <Verify no regressions in ...>

## Notes
<Any reviewer notes, migration steps, or deployment considerations>
<Link to plan/spec if applicable>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**Rules:**
- Summary focuses on **why**, not **what**
- Test plan has actionable, specific items
- Notes section only if needed
- Omit empty sections

### Step 6: Preview and Confirm

Present draft:

```
## PR Preview

**Title:** feat: add user authentication with JWT

**Base:** main ← feature/auth

**Summary:**
- Add JWT-based auth middleware for API endpoints
- Create login/signup endpoints with password hashing
- Add auth guard to protected routes

**Test Plan:**
- [ ] Login with valid credentials returns JWT
- [ ] Invalid credentials return 401
- [ ] Protected routes reject unauthenticated requests

**Commits (3):**
- abc1234 feat: add auth middleware
- def5678 feat: add login/signup endpoints
- ghi9012 feat: protect API routes

Shall I create this PR?
```

Use `AskUserQuestion` with options: **"Create PR"**, **"Edit first"**, **"Cancel"**.

### Step 7: Push and Create PR

```bash
# Check if a PR already exists for this branch
gh pr list --head "$(git branch --show-current)" --json number,url,state

# If PR exists, offer to update it instead of creating a new one

# Push branch if not already pushed (with upstream tracking)
# Only run if Step 3 determined branch doesn't exist on remote
git push -u origin "$(git branch --show-current)"

# Create PR using gh CLI
gh pr create --title "<title>" --base <base-branch> --body "$(cat <<'EOF'
<body content>
EOF
)"
```

**IMPORTANT:** Use HEREDOC for body to preserve formatting.
**NOTE:** Check for existing PRs before creating to avoid failures.

### Step 8: Report Result

```bash
# Get the PR URL from gh output (it prints the URL)
# Also fetch PR number for reference
gh pr view --json number,url --jq '"\(.number) \(.url)"'
```

```
✅ PR created successfully!

**PR #42:** feat: add user authentication with JWT
**URL:** https://github.com/headout/repo/pull/42
**Base:** main ← feature/auth

Next steps:
- Request reviewers: gh pr edit 42 --add-reviewer @teammate
- Add labels: gh pr edit 42 --add-label "feature"
- View checks: gh pr checks 42
```

### Step 9 (Optional): Follow-up Actions

Use `AskUserQuestion`:
- **"Add reviewers"** → ask for usernames, run `gh pr edit <number> --add-reviewer`
- **"Add labels"** → ask for labels, run `gh pr edit <number> --add-label`
- **"Done"** → finish

## Pipeline Integration

```
/feature-interview → SPEC
        |
/create-plan → PLAN
        |
/create-jira-tickets → Jira Epic/Stories/Sub-tasks
        |
/implement-plan → Code implementation
        |
/commit → Git commits
        |
/create-pr → GitHub Pull Request  ← THIS SKILL
```

## Edge Cases

### Branch Already Has Open PR
```bash
gh pr list --head $(git branch --show-current) --json number,url,state
```
If PR exists:
```
ℹ️ An open PR already exists for this branch:
PR #42: https://github.com/headout/repo/pull/42

Would you like to:
1. View/update the existing PR
2. Close it and create a new one
```

### No Commits Ahead of Base
```
ℹ️ No new commits found on this branch vs origin/<base>.
Nothing to create a PR for.
```

### Merge Conflicts with Base
```bash
# Check mergeability
gh pr view <number> --json mergeable
```
If not mergeable:
```
⚠️ This PR has merge conflicts with <base>.
Resolve with: git fetch origin && git merge origin/<base>
```

## Requirements

- **gh CLI**: Installed and authenticated
- **Git**: Clean working directory, commits ahead of base
- **Network**: Access to push and create PRs
