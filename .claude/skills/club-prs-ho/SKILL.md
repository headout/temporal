---
name: club-prs
description: "Merges several GitHub PRs into one combined branch, resolving conflicts and producing a single integrated branch. Use when the user wants to club, combine, or merge multiple PRs/pull requests together (e.g. \"club PRs 123 and 456\")."
---

# Club PRs

Merge multiple PRs into single combined branch. Takes PR numbers/URLs, creates fresh branch from main/master, merges each sequentially, resolves conflicts with user guidance, generates combined description.

## When to Use

- Combining related PRs into single release branch
- Testing multiple features together before merging
- Creating deployment branch from several in-flight PRs
- Consolidating dependent PRs that need to land together

## Input Formats

Accept: PR numbers (`123 456 789`, `#123 #456`), GitHub URLs, or mixed.

**IMPORTANT:** All PRs must be from SAME repository. Cross-repo not supported. If URLs from different repos, stop and ask user.

## Process

### Step 1: Gather PR Information

If not provided, ask for PR numbers/URLs. Note: all PRs must be from same repo.

### Step 2: Validate Repository Access

```bash
gh auth status
gh pr view <FIRST_PR_NUMBER> --json number 2>/dev/null || echo "Cannot access PR"
```

Access fails → stop, inform user (check directory, auth, permissions).

For each PR, fetch title, description, source branch, author, status, base branch:
```bash
gh pr view <PR_NUMBER> --json title,body,headRefName,author,state,baseRefName
```

### Step 3: Fetch Latest and Determine Base

```bash
git fetch origin

if git ls-remote --heads origin main | grep -q refs/heads/main; then
    BASE_BRANCH="origin/main"
elif git ls-remote --heads origin master | grep -q refs/heads/master; then
    BASE_BRANCH="origin/master"
else
    echo "Neither main nor master found - ask user"
fi

git rev-parse --short $BASE_BRANCH
```

Show PR list and ask user to confirm before proceeding.

### Step 4: Create Combined Branch

```bash
git checkout -b combined/<descriptive-name> origin/main
```

Naming: `combined/YYYYMMDD-brief-description` (e.g. `combined/20260205-auth-payment-ui`)

### Step 5: Merge PRs Sequentially

For each PR, use FETCH_HEAD to avoid temp branch conflicts:

```bash
git fetch origin pull/<PR_NUMBER>/head
git merge FETCH_HEAD --no-edit -m "Merge PR #<PR_NUMBER>: <PR_TITLE>"
```

Alternative (if inspection needed):
```bash
git fetch origin pull/<PR_NUMBER>/head:pr-<PR_NUMBER> --force
git merge pr-<PR_NUMBER> --no-edit -m "Merge PR #<PR_NUMBER>: <PR_TITLE>"
git branch -d pr-<PR_NUMBER>
```

### Step 6: Handle Conflicts

#### All Conflicts Require User Review

**Do NOT auto-resolve without explicit user confirmation.**

```bash
git diff --name-only --diff-filter=U
```

**Lock files** (package-lock.json, yarn.lock): recommend accept either version, regenerate after ALL merges (`rm lock && npm install`). Ask to confirm.

**Code conflicts** — ALWAYS show conflict details and ask:
```
⚠️ Conflict detected merging PR #456

**Conflicting files:**
- src/services/payment.ts

**Conflict details:**
[show <<<<<<< / ======= / >>>>>>> markers]

How should I resolve?
1. Keep both changes
2. Prefer PR #X's version
3. Prefer PR #Y's version
4. Custom resolution
```

Wait for user response.

### Step 7: Generate Combined Description

```markdown
# Combined PR: [Generated Title from PR contents]

This branch combines the following PRs:

## Included PRs

### PR #123: Add user authentication
**Author:** @author1
**Original Description:**
> [PR description here]

---

### PR #456: Fix payment processing  
**Author:** @author2
**Original Description:**
> [PR description here]

---

## Merge Summary

- Total commits: X
- Files changed: Y
- Conflicts resolved: Z (list if any)

## Testing Notes

⚠️ **Important:** Individual PRs may have passed CI, but the combined branch should be re-tested.

Please test the following areas affected by this combined change:
- [Area 1 from PR descriptions]
- [Area 2 from PR descriptions]

Run full test suite: `npm test` / `yarn test` / `make test`
```

### Step 8: Final Summary

Show: merged PRs with status, conflicts resolved, next steps (review, test, push, create PR). Offer to push or create PR.

## Error Handling

- **PR Not Found**: inform user, offer to continue with remaining
- **PR Already Merged**: check if changes in base via `git merge-base --is-ancestor`; skip if included, ask if not
- **PR Closed (Not Merged)**: ask user if still want to include
- **Unresolvable Conflict**: offer to show markers, skip PR, or abort

## Requirements

- **gh CLI** installed and authenticated
- **Clean working directory**
- **Same repository** for all PRs

## Quick Reference

```bash
gh auth status
gh pr view <number> --json title,body,headRefName,author,state,baseRefName
git fetch origin pull/<number>/head
git merge FETCH_HEAD -m "Merge PR #<number>"
git diff --name-only --diff-filter=U
git merge --abort
# Reset (⚠️ -D force-deletes!):
git checkout main && git branch -d combined/<name>
```

## Revising a Combined Branch

**Option 1 (Recommended):** New branch with different name
**Option 2:** Force-push with `--force-with-lease` (only if sole user of branch)
