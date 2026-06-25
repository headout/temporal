---
name: update-pr-stack
description: "Updates the descriptions of every PR in a stacked PR tree, adding a dependency visualization showing how the PRs build on each other. Use when the user works with stacked or dependent PRs and says \"pr stack\", \"stacked pr\", \"pr chain\", or \"dependent prs\"."
argument-hint: "<base-pr-number>"
allowed-tools:
  - "Bash(gh pr view:*)"
  - "Bash(gh pr list:*)"
  - "Bash(gh pr edit:*)"
  - "Bash(gh pr diff:*)"
---

Update all PR descriptions in a stacked PR tree with dependency visualizations and concise summaries.

Base PR number: $ARGUMENTS

Use `gh` CLI for all GitHub operations.

---

## Step 1: Discover PR tree

Fetch base PR:
```bash
gh pr view $ARGUMENTS --json number,title,headRefName,baseRefName,state,body,url
```

BFS to find all child PRs. Maintain `Set<branchName>` of visited branches to avoid duplicates. For each unvisited branch:
```bash
gh pr list --base <branch-name> --state all --limit 100 --json number,title,headRefName,baseRefName,state,body,url
```

Build tree: `{ number, title, branch, baseBranch, state, body, url, children[] }`.

Keep traversing until no new children. Cap BFS at 20 levels.

No children found → update base PR summary if needed, report "No child PRs found for #$ARGUMENTS", stop.

---

## Step 2: Generate tree visualization

ASCII tree in markdown code block with "you are here" marker.

Status indicators:
- `✅` merged
- `⏳` open
- `❌` closed (not merged)

Format:
```
#993 ⏳ 360 UI changes (base)
 ├── #1000 ✅ kebab case file names
 ├── #1002 ✅ new 360 RMS addition
 └── #1027 ⏳ copy & UX polish 👈 you are here
      └── #1015 ⏳ analytics events
           └── #1029 ⏳ test coverage
```

Rules:
- `├──` for non-last children, `└──` for last child
- Indent: `(depth - 1) * 5 + 1` spaces per level
- `👈 you are here` only on PR being updated
- Base PR gets `(base) 👈 you are here` in its own description
- Truncate titles to ~50 chars

---

## Step 3: Detect empty vs existing descriptions

Strip standard template sections (`# Description`, `# Checklist`, `# Type of Change`, `# How Has This Been Tested`, etc.) and empty checkbox lists.

After stripping:
- < 20 chars remaining → **empty** (needs generated summary)
- Has `## Summary` section → **preserve it**, update tree/parent ref only
- Substantial content without `## Summary` → preserve as summary

---

## Step 4: Generate summary for empty PRs

```bash
gh pr diff <number> --name-only
```

```bash
gh pr diff <number> | head -200
```

Write 2-4 bullet summary. Example:
```markdown
## Summary
- Added kebab-case file renaming for all component files in `src/360/`
- Updated barrel exports and import paths across 12 files
- No functional changes — purely organizational
```

---

## Step 5: Update each PR description

### Base PR:
Add/replace `## PR Stack` at **top**, preserve rest:

```markdown
## PR Stack
\`\`\`
<tree visualization with 👈 you are here on this PR>
\`\`\`

---

<rest of existing body, preserved as-is>
```

### Child PRs:
Add/replace parent ref + `## PR Stack` at **top**, preserve rest:

```markdown
> **Parent PR:** [#<parent-number> — <parent-title>](<parent-url>)
> Targets `<base-branch-name>` — review against that base.

## PR Stack
\`\`\`
<tree visualization with 👈 you are here on this PR>
\`\`\`

---

## Summary
<preserved or generated summary bullets>

<rest of existing body content, preserved as-is>
```

If `## PR Stack` exists, replace only it (and parent ref block). Preserve everything else.

### Skip rules:
- Do NOT update closed/abandoned PRs (CLOSED and not MERGED)
- MERGED PRs: still update with tree (show as "updated" in report)
- Closed-not-merged: show in tree with ❌ but don't edit

### Applying updates:

```bash
# Ensure cleanup on error
trap 'rm -f /tmp/pr-body-*.md' EXIT

# Write body to temp file
cat > /tmp/pr-body-<number>.md << 'EOF_PR_BODY_d8f7a92b'
<full new body content>
EOF_PR_BODY_d8f7a92b

# Update the PR
gh pr edit <number> --body-file /tmp/pr-body-<number>.md

# Clean up
rm -f /tmp/pr-body-<number>.md
```

IMPORTANT: Use `--body-file` with temp file, NOT `--body` inline, to avoid shell escaping issues.

---

## Step 6: Report results

```
Updated N PRs:
  #993  (base)   — updated tree
  #1027 (child)  — updated tree + generated summary
  #1015 (child)  — updated tree, preserved existing summary
  #1000 (merged) — updated tree
  #999  (skip)   — closed, not updated
```

Include base PR URL for verification.

---

## Important notes

- Always fetch fresh PR data before updating
- Use `--limit 100` on all `gh pr list` calls
- State mapping: MERGED → ✅, OPEN → ⏳, CLOSED (not merged) → ❌
- Tree identical across all PRs except `👈 you are here` position
- Preserve images, links, formatting in existing descriptions
- Empty/invalid `$ARGUMENTS` → ask user for base PR number
