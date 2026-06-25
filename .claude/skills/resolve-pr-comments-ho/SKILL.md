---
name: resolve-pr-comments
description: "Resolves open PR review comments by making the requested code changes and replying in the same review thread. Use when the user wants to resolve, address, or fix PR/review comments or feedback, or says \"address review\", \"resolve review comments\", \"fix pr comments\"."
---

# Resolve PR Comments

Fetch PR review comments, make code changes, reply to same thread.

## When to Use

- "resolve PR comments", "address review feedback", "fix PR comments"
- Working through review comments on a PR

## Process

### Step 1: Identify PR

**With PR number/URL argument:**
- Extract PR number, validate: `gh pr view <N> --json number,headRefName`

**No argument:**
  ```bash
  gh pr view --json number,headRefName,url
  ```
- If no PR found, stop.

### Step 2: Detect Repo

```bash
gh repo view --json nameWithOwner --jq '.nameWithOwner'
```

### Step 3: Fetch Review Comments

```bash
gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
  --jq '[.[] | {id, in_reply_to_id, path, line, original_line, side, diff_hunk, body, user: .user.login, created_at, updated_at}]'
```

### Step 4: Group Into Threads

- `in_reply_to_id == null` = **thread starter**
- `in_reply_to_id != null` = **reply** (group under parent)
- Use top-level comment ID for replies

### Step 5: Filter Actionable Comments

Skip threads where:
- Last reply is from PR author (already addressed)
- Comment is purely compliment/acknowledgment

Present remaining:
```
Found N actionable review comments on PR #X:

1. [path/to/file.ts:42] @reviewer: "Consider using const here instead of let"
2. [path/to/other.ts:15] @reviewer: "This should handle the null case"
...

Shall I work through these one by one?
```

### Step 6: Process Each Comment

1. **Show context:** `diff_hunk`, comment body, replies, file path + line
2. **Read current file** at specified path
3. **Make code change** and show user what changed
4. **Ask user to confirm:**
   - **Yes, commit and reply** -- commit, push, reply to thread
   - **Yes, but don't commit yet** -- keep change, reply, next
   - **Skip this comment** -- revert, next
   - **Let me handle this manually** -- leave change, next

5. **Reply to thread:**

   **CRITICAL: Always reply to SAME thread. NEVER create new top-level comment.**

   Trace `in_reply_to_id` back to root to find thread starter ID.

   ```bash
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments/{top_level_comment_id}/replies \
     -f body="Addressed: <short summary of what was changed>"
   ```

   **NEVER use this (it creates a NEW top-level comment):**
   ```bash
   # WRONG - creates new thread
   gh api repos/{owner}/{repo}/pulls/{pr_number}/comments \
     -f body="..." -f commit_id="..." -f path="..." -f line=10
   ```

   **NEVER use this (it creates a general issue comment, not a review reply):**
   ```bash
   # WRONG - creates issue-level comment
   gh api repos/{owner}/{repo}/issues/{pr_number}/comments \
     -f body="..."
   ```

6. **If committing:**
   ```bash
   git add <changed_file>
   git commit -m "review: <short description of change>"
   git push
   ```

### Step 7: Summary

```
PR Comment Resolution Summary:
- Resolved: N comments (committed and replied)
- Skipped: M comments
- Pending: K comments (changes made but not committed)

Files modified: [list]
```

## Reply Format

- "Addressed: renamed `getData` to `fetchUserData` for clarity"
- "Addressed: added null check before accessing `user.email`"
- "Addressed: switched from `let` to `const` since value is never reassigned"

## Error Handling

- **No PR found**: "No open PR found for current branch. Provide a PR number: `/resolve-pr-comments 123`"
- **No review comments**: "No review comments found on PR #X"
- **gh CLI not authenticated**: "Please run `gh auth login` first"
- **Push fails**: Show error, suggest user resolves manually
- **Too complex**: "This comment may require architectural changes. Skipping -- address manually."

## Requirements

- `gh` CLI installed and authenticated
- Git repo with push access to branch
