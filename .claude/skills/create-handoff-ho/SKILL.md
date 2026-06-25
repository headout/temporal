---
name: create-handoff
description: "Writes a handoff document capturing current state, decisions, and next steps so work can be picked up in a fresh session or by another person. Use when the user says \"create handoff\", \"handoff\", wants to preserve/save work or progress, or is about to clear before context fills up."
---

# Create Handoff

Write a handoff document to transfer work to another agent session. Be thorough but **concise** — compact and summarize context without losing key details.

## Process
### 1. Filepath & Metadata

**Determine session/folder name:**
- Working on a ticket (e.g., `ENG-1234`) → use ticket as folder name
- Working from a ledger (`thoughts/ledgers/*.md`) → extract session name from filename
- Otherwise → use `general`

**File path:** `thoughts/shared/handoffs/{session-name}/YYYY-MM-DD_HH-MM-SS_description.md`
- `YYYY-MM-DD` = today's date, `HH-MM-SS` = current time (24h)
- `description` = brief kebab-case description

**Examples:**
- For ticket ENG-1234: `thoughts/shared/handoffs/ENG-1234/2026-01-08_13-55-22_add-auth-middleware.md`
- From ledger: `thoughts/shared/handoffs/open-source-release/2026-01-08_13-55-22_create-context-compaction.md`
- General: `thoughts/shared/handoffs/general/2026-01-08_13-55-22_create-context-compaction.md`

### 2. Handoff Writing

Use the filepath and YAML frontmatter pattern below:

```markdown
---
date: [Current date and time with timezone in ISO format]
session_name: [From ledger, e.g., "open-source-release" - see step 1]
researcher: [Researcher name from thoughts status]
git_commit: [Current commit hash]
branch: [Current branch name]
repository: [Repository name]
topic: "[Feature/Task Name] Implementation Strategy"
tags: [implementation, strategy, relevant-component-names]
status: complete
last_updated: [Current date in YYYY-MM-DD format]
last_updated_by: [Researcher name]
type: implementation_strategy
---

# Handoff: {very concise description}

## Task(s)
{description of the task(s) that you were working on, along with the status of each (completed, work in progress, planned/discussed). If you are working on an implementation plan, make sure to call out which phase you are on. Make sure to reference the plan document and/or research document(s) you are working from that were provided to you at the beginning of the session, if applicable.}

## Critical References
{List any critical specification documents, architectural decisions, or design docs that must be followed. Include only 2-3 most important file paths. Leave blank if none.}

## Recent changes
{describe recent changes made to the codebase that you made in line:file syntax}

## Learnings
{describe important things that you learned - e.g. patterns, root causes of bugs, or other important pieces of information someone that is picking up your work after you should know. consider listing explicit file paths.}

## Post-Mortem (Required for Artifact Index)

### What Worked
{Describe successful approaches, patterns that helped, tools that worked well. Be specific - these get indexed for future sessions.}
- Approach 1: [what and why it worked]
- Pattern: [pattern name] was effective because [reason]

### What Failed
{Describe attempted approaches that didn't work, errors encountered, dead ends. This helps future sessions avoid the same mistakes.}
- Tried: [approach] → Failed because: [reason]
- Error: [error type] when [action] → Fixed by: [solution]

### Key Decisions
{Document important choices made during this task and WHY they were made. Future sessions will reference these.}
- Decision: [choice made]
  - Alternatives considered: [other options]
  - Reason: [why this choice]

## Artifacts
{ an exhaustive list of artifacts you produced or updated as filepaths and/or file:line references - e.g. paths to feature documents, implementation plans, etc that should be read in order to resume your work.}

## Action Items & Next Steps
{ a list of action items and next steps for the next agent to accomplish based on your tasks and their statuses}

## Other Notes
{ other notes, references, or useful information - e.g. where relevant sections of the codebase are, where relevant documents are, or other important things you leanrned that you want to pass on but that don't fall into the above categories}
```
---

### 3. Confirm Completion

After creating the handoff:

```
Handoff created at: [path/to/handoff.md]

Resume in a new session with:
/resume-handoff path/to/handoff.md
```

---
## Additional Notes
- **More information, not less.** This defines the minimum; always include more if needed.
- **Be thorough and precise.** Include top-level objectives and lower-level details.
- **Avoid excessive code snippets.** Prefer `path/to/file.ext:line` references over large code blocks/diffs. Only include snippets when necessary (e.g., pertains to an error being debugged).
