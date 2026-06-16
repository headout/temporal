---
name: resume-handoff
description: "Resumes work from an existing handoff document, re-reading its state, validating against the current codebase, and continuing where the prior session stopped. Use when the user says \"resume handoff\", \"continue from handoff\", \"load the handoff\", or references the latest handoff."
---

# Resume work from a handoff document

Resume work from handoff documents containing critical context, learnings, and next steps from previous sessions.

## Initial Response

1. **If handoff path provided**:
   - Read handoff document FULLY
   - Read linked research/plan docs under `thoughts/shared/plans` or `thoughts/shared/research` directly (NOT via sub-agent)
   - Ingest context, read additional mentioned files
   - Propose course of action; confirm or clarify direction

2. **If ticket number provided (e.g. ENG-XXXX)**:
   - Locate handoffs in `thoughts/shared/handoffs/ENG-XXXX/`. **List directory contents.**
   - Zero files or missing directory → ask user for path
   - One file → proceed with it
   - Multiple files → use most recent (filename format `YYYY-MM-DD_HH-MM-SS`)
   - Read handoff FULLY, read linked plans/research directly (NOT via sub-agent)
   - Ingest context, propose action, confirm direction

3. **If no parameters**, respond:
```
I'll help you resume work from a handoff document. Let me find the available handoffs.

Which handoff would you like to resume from?

Tip: You can invoke this command directly with a handoff path: `/resume-handoff `thoughts/shared/handoffs/ENG-XXXX/YYYY-MM-DD_HH-MM-SS_ENG-XXXX_description.md`

or using a ticket number to resume from the most recent handoff for that ticket: `/resume-handoff ENG-XXXX`
```

Then wait for input.

## Process Steps

### Step 1: Read and Analyze Handoff

1. **Read completely** (no limit/offset):
   - Extract: task statuses, recent changes, learnings, artifacts, action items, notes

2. **Spawn parallel research tasks** to verify current state:

   ```
   Task 1 - Gather artifact context:
   Read all artifacts mentioned in the handoff.
   1. Read feature documents listed in "Artifacts"
   2. Read implementation plans referenced
   3. Read any research documents mentioned
   4. Extract key requirements and decisions
   Use tools: Read
   Return: Summary of artifact contents and key decisions
   ```

3. **Wait for ALL sub-tasks** before proceeding

4. **Read critical files**: Learnings section files, Recent changes files, newly discovered related files

### Step 2: Synthesize and Present

```
I've analyzed the handoff from [date] by [researcher]. Here's the current situation:

**Original Tasks:**
- [Task 1]: [Status from handoff] → [Current verification]
- [Task 2]: [Status from handoff] → [Current verification]

**Key Learnings Validated:**
- [Learning with file:line reference] - [Still valid/Changed]
- [Pattern discovered] - [Still applicable/Modified]

**Recent Changes Status:**
- [Change 1] - [Verified present/Missing/Modified]
- [Change 2] - [Verified present/Missing/Modified]

**Artifacts Reviewed:**
- [Document 1]: [Key takeaway]
- [Document 2]: [Key takeaway]

**Recommended Next Actions:**
Based on the handoff's action items and current state:
1. [Most logical next step based on handoff]
2. [Second priority action]
3. [Additional tasks discovered]

**Potential Issues Identified:**
- [Any conflicts or regressions found]
- [Missing dependencies or broken code]

Shall I proceed with [recommended action 1], or would you like to adjust the approach?
```

Get confirmation before proceeding.

### Step 3: Create Action Plan

1. **TodoWrite** to create task list from handoff action items + discovered tasks, prioritized by dependencies
2. Present plan and confirm readiness

### Step 4: Begin Implementation

1. Start with first approved task
2. Reference handoff learnings throughout
3. Apply documented patterns
4. Update progress as tasks complete

## Guidelines

1. **Thorough Analysis**: Read entire handoff first; verify ALL mentioned changes; check for regressions; read all artifacts
2. **Interactive**: Present findings before work; get buy-in; allow course corrections
3. **Leverage Handoff Wisdom**: Apply "Learnings" patterns; avoid documented mistakes; build on discovered solutions
4. **Track Continuity**: Use TodoWrite; reference handoff in commits; document deviations; consider new handoff when done
5. **Validate Before Acting**: Never assume handoff state matches current; verify file refs exist; check for breaking changes

## Common Scenarios

### Clean Continuation
All changes present, no conflicts, clear next steps → proceed with recommended actions

### Diverged Codebase
Changes missing/modified, new related code → reconcile differences, adapt plan

### Incomplete Handoff Work
Tasks "in_progress" → complete unfinished work first, re-understand partial implementations

### Stale Handoff
Significant time passed, major refactoring → re-evaluate strategy

## Example Flow

```
User: /resume-handoff specification/feature/handoffs/handoff-0.md
Assistant: Let me read and analyze that handoff document...

[Reads handoff completely]
[Spawns research tasks]
[Waits for completion]
[Reads identified files]

I've analyzed the handoff from [date]. Here's the current situation...

[Presents analysis]

Shall I proceed with implementing the webhook validation fix, or would you like to adjust the approach?

User: Yes, proceed with the webhook validation
Assistant: [Creates todo list and begins implementation]
```
