---
name: create-jira-tickets
description: "Creates a Jira hierarchy of Epic, Stories, and Sub-tasks from a feature spec or implementation plan via the Atlassian MCP. Use when the user wants to create Jira tickets/issues, turn a plan or spec into tickets, or says \"create tickets\", \"jira tickets\", \"tickets from plan\"."
---

# Create Jira Tickets

Create structured Jira tickets from plans/specs via Atlassian MCP.

## When to Use

- After `/create-plan` to track work in Jira
- After `/feature-interview` + `/create-plan` for rich descriptions
- Need Epic with Stories/Sub-tasks from phased plan

## Prerequisites

- Atlassian MCP server in `.mcp.json` (OAuth prompts on first use)
- Jira project access with issue creation permissions
- On MCP auth errors, instruct user to run `/mcp` and authenticate

## Invocation

```
/create-jira-tickets <plan-file> [spec-file]
```

- **plan-file** (required): Path to plan (e.g., `thoughts/shared/plans/2026-02-06-feature.md`)
- **spec-file** (optional): Path to spec (e.g., `thoughts/shared/specs/SPEC-feature.md`)

## Workflow

### Step 1: Read Inputs

1. Read plan file **fully** (no limit/offset)
2. If spec provided, read fully
3. Extract: feature name (`# Title`), phases, changes per phase, success criteria

### Step 2: Ask for Project Key

`AskUserQuestion` with options:
- **CVR** -- Conversion | **DIS** -- Discovery | **SUP** -- Supply
- **ACQ** -- Acquisition | **HUB** -- Hub | **PLT** -- Platform
- **API** -- API | **APP** -- App | **CX** -- Customer Experience
- **BM** -- Booking Management | **DST** -- Distribution

### Step 2b: Ask for Epic Deadline

`AskUserQuestion`: "Deadline for this Epic? (YYYY-MM-DD)"
Options: **"1 week"**, **"2 weeks"**, **"1 month"**, **"Other"**.
Calculate date from today. Set as `duedate` on Epic in Step 6.

### Step 3: Discover Issue Types

1. Call `getJiraProjectIssueTypesMetadata` for chosen project
2. Find IDs for: **Epic**, **Story**, **Sub-task** (or Task)
3. Fall back to available types if needed

### Step 4: Build Ticket Hierarchy

```
Epic: "{Feature Name}" (from # Title)
  +-- Story: "Phase 1: {Name}" (from ## Phase N sections)
  |     +-- Sub-task: "{Change}" (from ### Changes Required items)
  |     +-- Sub-task: ...
  +-- Story: "Phase 2: {Name}"
  |     +-- Sub-task: ...
  +-- Story: "Testing & Validation" (from ## Testing Strategy)
        +-- Sub-task: per test category
```

**Mapping:**
- `# Title` -> Epic summary | `## Overview` -> Epic description
- `## Phase N: Name` -> Story summary
- Phase overview + criteria -> Story description (checklist)
- `### Changes Required` items -> Sub-task summaries
- File paths/code context -> Sub-task descriptions
- `## Testing Strategy` -> Story with test sub-tasks
- Spec acceptance criteria -> Added to relevant Stories

### Step 5: Preview for Approval

```
| # | Type     | Summary              | Parent  |
|---|----------|----------------------|---------|
| 1 | Epic     | Feature Name         | -       |
| 2 | Story    | Phase 1: Setup       | Epic    |
| 3 | Sub-task | Create schema        | Story 2 |
| 4 | Sub-task | Add migrations       | Story 2 |
| 5 | Story    | Phase 2: API         | Epic    |
| ...                                           |
```

`AskUserQuestion`: **"Create all"**, **"Edit first"**, **"Cancel"**.

### Step 6: Create Tickets via MCP

1. Create **Epic** first via `createJiraIssue`
2. Create each **Story** with Epic link
3. Create each **Sub-task** with parent Story
4. Capture returned issue key after each
5. On failure, report error and continue

### Step 7: Report Summary

```
## Jira Tickets Created

| Key     | Type     | Summary              |
|---------|----------|----------------------|
| ENG-100 | Epic     | Feature Name         |
| ENG-101 | Story    | Phase 1: Setup       |
| ENG-102 | Sub-task | Create schema        |
| ...     | ...      | ...                  |

Total: X tickets created (Y Epic, Z Stories, W Sub-tasks)
```

### Step 8: Offer Assignment

`AskUserQuestion`: "Assign all tickets to yourself?"
- **Yes** -- Get account ID via `atlassianUserInfo`, set assignee via `editJiraIssue`
- **No** -- Skip

## Pipeline

```
/feature-interview -> SPEC
        |
/create-plan -> PLAN
        |
/create-jira-tickets -> Jira Epic/Stories/Sub-tasks
        |
/implement-plan -> Code implementation
```
