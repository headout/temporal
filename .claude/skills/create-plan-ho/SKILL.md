---
name: create-plan
description: "Produces a detailed, validated implementation plan in thoughts/shared/plans/ through codebase research and iteration. Use when the user asks to \"create/make a plan\", \"plan this\", \"how should we implement\", or \"design the approach\". Not for executing an existing plan (use implement-plan)."
---

# Implementation Plan

Create detailed implementation plans through interactive, iterative process. Be skeptical, thorough, collaborative.

## Initial Response

1. **If parameters provided**: skip default message, read provided files FULLY, begin research
2. **If no parameters**:
```
I'll help you create a detailed implementation plan. Let me start by understanding what we're building.

Please provide:
1. The task/ticket description (or reference to a ticket file)
2. Any relevant context, constraints, or specific requirements
3. Links to related research or previous implementations

I'll analyze this information and work with you to create a comprehensive plan.
```

## Process Steps

### Step 1: Context Gathering & Initial Analysis

1. **Read all mentioned files FULLY** (tickets, research docs, plans, JSON). Use Read tool WITHOUT limit/offset. **CRITICAL**: Read files yourself in main context before spawning sub-tasks. Never read partially.

2. **Spawn initial research** (parallel, before asking questions):
   - **codebase-locator** agent → find all files related to task
   - **codebase-analyzer** agent → understand current implementation

3. **Read ALL files identified by research** fully into main context

4. **Analyze**: cross-reference requirements with code, identify discrepancies, note assumptions needing verification

5. **Present understanding + focused questions** (only ask what code investigation can't answer):
   ```
   Based on the ticket and my research of the codebase, I understand we need to [accurate summary].

   I've found that:
   - [Current implementation detail with file:line reference]
   - [Relevant pattern or constraint discovered]
   - [Potential complexity or edge case identified]

   Questions that my research couldn't answer:
   - [Specific technical question that requires human judgment]
   - [Business logic clarification]
   - [Design preference that affects implementation]
   ```

### Step 2: Research & Discovery

1. **If user corrects misunderstanding**: DO NOT just accept — spawn new research to verify, read files they mention, only proceed after verifying yourself

2. **Create research todo list** via TodoWrite

3. **Spawn parallel sub-tasks**:
   - **codebase-locator** — find specific files
   - **codebase-analyzer** — understand implementation details
   - **codebase-pattern-finder** — find similar features to model after
   - WebSearch for quick external lookups (don't block on extensive research — validation step catches issues)

4. **Wait for ALL sub-tasks**, then present findings and design options:
   ```
   Based on my research, here's what I found:

   **Current State:**
   - [Key discovery about existing code]
   - [Pattern or convention to follow]

   **Design Options:**
   1. [Option A] - [pros/cons]
   2. [Option B] - [pros/cons]

   **Open Questions:**
   - [Technical uncertainty]
   - [Design decision needed]

   Which approach aligns best with your vision?
   ```

### Step 2.5: Deep Requirements Interview

**CRITICAL:** Before writing any plan, conduct thorough interview using `AskUserQuestion`. Dig into non-obvious implications and second-order effects. Continue until all ambiguity resolved.

**Categories to cover:**

1. **Technical Implementation** — architecture tradeoffs, data flow, API contracts, error handling, performance constraints
2. **Edge Cases & Failure Modes** — what happens when X fails, concurrency, partial failure recovery, data consistency
3. **UX** (if applicable) — loading states, error messages, accessibility, mobile
4. **Operational** — monitoring, debugging, rollback, feature flags
5. **Non-Obvious Implications** — second-order effects, future extensibility, migration path, backwards compatibility

**Best practices:**
- 2-4 focused questions per round via `AskUserQuestion`
- Group related questions, provide meaningful options
- Don't ask what code research can answer
- If user says "you decide" → decide and document rationale

**Done when:** all design decisions resolved (no TBD), edge cases defined, performance quantified, failure modes documented, user approved moving to plan writing.

### Step 3: Plan Structure

Propose outline, get feedback before writing details:
```
Here's my proposed plan structure:

## Overview
[1-2 sentence summary]

## Implementation Phases:
1. [Phase name] - [what it accomplishes]
2. [Phase name] - [what it accomplishes]
3. [Phase name] - [what it accomplishes]

Does this phasing make sense? Should I adjust the order or granularity?
```

### Step 4: Detailed Plan Writing

1. Run `mkdir -p thoughts/shared/plans`
2. Write to `thoughts/shared/plans/YYYY-MM-DD-description.md`

Template:

````markdown
# [Feature/Task Name] Implementation Plan

## Overview

[Brief description of what we're implementing and why]

## Current State Analysis

[What exists now, what's missing, key constraints discovered]

## Desired End State

[A Specification of the desired end state after this plan is complete, and how to verify it]

### Key Discoveries:
- [Important finding with file:line reference]
- [Pattern to follow]
- [Constraint to work within]

## What We're NOT Doing

[Explicitly list out-of-scope items to prevent scope creep]

## Implementation Approach

[High-level strategy and reasoning]

## Phase 1: [Descriptive Name]

### Overview
[What this phase accomplishes]

### Changes Required:

#### 1. [Component/File Group]
**File**: `path/to/file.ext`
**Changes**: [Summary of changes]

```[language]
// Specific code to add/modify
```

### Success Criteria:

#### Automated Verification:
- [ ] Migration applies cleanly: `make migrate`
- [ ] Unit tests pass: `make test`
- [ ] Type checking passes: `npm run typecheck`
- [ ] Linting passes: `make lint`

#### Manual Verification:
- [ ] Feature works as expected when tested via UI
- [ ] Performance is acceptable under load
- [ ] Edge case handling verified manually
- [ ] No regressions in related features

**Implementation Note**: After completing this phase and all automated verification passes, pause here for manual confirmation from the human that the manual testing was successful before proceeding to the next phase.

---

## Phase 2: [Descriptive Name]

[Similar structure with both automated and manual success criteria...]

---

## Testing Strategy

### Unit Tests:
- [What to test]
- [Key edge cases]

### Integration Tests:
- [End-to-end scenarios]

### Manual Testing Steps:
1. [Specific step to verify feature]
2. [Another verification step]
3. [Edge case to test manually]

## Performance Considerations

[Any performance implications or optimizations needed]

## Migration Notes

[If applicable, how to handle existing data/systems]

## References

- Original ticket: `[path to ticket]`
- Related research: `thoughts/shared/research/[relevant].md`
- Similar implementation: `[file:line]`
````

### Step 5: Review

Present plan location, iterate on feedback (phases, approach, criteria, scope) until user satisfied.

## Guidelines

1. **Be Skeptical**: question vague requirements, identify issues early, verify with code
2. **Be Interactive**: don't write full plan in one shot, get buy-in at each step
3. **Be Thorough**: read all files FULLY, research with parallel agents, include file:line refs, measurable success criteria
4. **Be Practical**: incremental testable changes, consider migration/rollback, include "what we're NOT doing"
5. **Track Progress**: TodoWrite for planning tasks
6. **No Open Questions in Final Plan**: if questions arise, STOP — research or ask immediately. Plan must be complete and actionable.

## Success Criteria: Always Two Categories

1. **Automated** (runnable by agents): commands, file existence, compilation, test suites
2. **Manual** (human testing): UI/UX, real-world performance, hard-to-automate edge cases

## Common Patterns

- **DB changes**: schema → store methods → business logic → API → clients
- **New features**: research patterns → data model → backend → API → UI
- **Refactoring**: document behavior → incremental changes → maintain compat → migration strategy

## Sub-task Best Practices

- Spawn multiple in parallel, each focused on specific area
- Include exact search targets, directories, expected output format
- Be EXTREMELY specific about directories (full paths)
- Specify read-only tools, request file:line references
- Wait for all tasks, verify results, follow up if unexpected

```python
tasks = [
    Task("Research database schema", db_research_prompt),
    Task("Find API patterns", api_research_prompt),
    Task("Investigate UI components", ui_research_prompt),
    Task("Check test patterns", test_research_prompt)
]
```
