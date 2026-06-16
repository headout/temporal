---
name: commit
description: "Stages and creates git commits with a clean conventional message and no AI attribution, asking for approval first. Use when the user says \"commit\", \"git commit\", \"commit these/my changes\", \"stage and commit\", or \"commit and push\"."
---

# Commit Changes

Create git commits for changes made during this session.

## Process:

1. **Assess changes:**
   - Review conversation history for what was accomplished
   - Run `git status` to see current changes
   - Run `git diff` to understand modifications
   - Decide: one commit or multiple logical commits

2. **Plan commits:**
   - Identify which files belong together
   - Draft clear, descriptive commit messages
   - Use imperative mood
   - Focus on why, not just what

3. **Present plan to user:**
   - List files for each commit
   - Show commit message(s)
   - Ask: "I plan to create [N] commit(s) with these changes. Shall I proceed?"

4. **Execute upon confirmation:**
   - Use `git add` with specific files (never `-A` or `.`)
   - Create commits with planned messages
   - Show result with `git log --oneline -n [number]`

## Commit Message Format:

```
<type>: <short summary>

<optional body explaining why>
```

Types: `feat`, `fix`, `docs`, `refactor`, `chore`, `style`, `test`

## Rules:
- You have full session context of what was done
- Group related changes together
- Keep commits focused and atomic
- User trusts your judgment
- Never use `git add -A` or `git add .` — always add specific files
