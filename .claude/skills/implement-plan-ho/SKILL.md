---
name: implement-plan
description: "Executes an existing plan from thoughts/shared/plans phase by phase, making code changes and verifying each step with tests. Use when the user says \"implement the plan\", \"execute the plan\", \"follow the plan\", or points at a plans/*.md file. Not for authoring a new plan (use create-plan)."
---

# Implement Plan

Implement approved technical plans from `thoughts/shared/plans/`. Plans contain phases with changes and success criteria.

## Execution Modes

### Mode 1: Direct Implementation (Default)
For small plans (≤3 tasks) or user-requested direct implementation.

### Mode 2: Agent Orchestration
For 4+ tasks or when context preservation matters.
- Thin orchestrator spawning agents per task
- Compaction-resistant via handoff files
- Say "I'll use agent orchestration for this plan" to activate

---

## Getting Started

With plan path:
1. Read plan fully, check for existing checkmarks `- [x]`
2. Read all referenced files fully (no limit/offset)
3. Think deeply about how pieces fit
4. Auto-create ledger if missing (see below)
5. Create todo list, start implementing

No path provided → ask for one.

### Auto-Create Ledger If Missing

Check for existing ledger:

```bash
ls thoughts/ledgers/*.md 2>/dev/null
```

**If none exists**, create from plan:

```bash
mkdir -p thoughts/ledgers
```

Template:

```markdown
# Session: <session-name-from-plan>
Updated: <ISO timestamp>

## Goal
<Extract from plan's objective/summary section>

## Constraints
<Extract from plan's constraints or assumptions>

## Key Decisions
<Extract from plan's design decisions, or leave empty>

## State
- Done:
  - (none yet)
- Now: [→] Phase 1: <first phase from plan>
- Next: Phase 2: <second phase from plan>
- Remaining:
  - [ ] Phase 3: <third phase>
  - [ ] Phase 4: <fourth phase>
  ... (all phases from plan)

## Open Questions
<Extract any open questions from plan, or leave empty>

## Working Set
- Branch: <current branch>
- Plan: thoughts/shared/plans/<plan-file>.md
- Test cmd: <from plan if specified>
```

Announce: `Created continuity ledger: thoughts/ledgers/<name>.md`

**If ledger exists**, read and verify it matches current plan.

## Implementation Philosophy

- Follow plan intent while adapting to reality
- Complete each phase fully before next
- Verify work in broader codebase context
- Update plan and ledger checkboxes as phases complete

On mismatch:
```
Issue in Phase [N]:
Expected: [what the plan says]
Found: [actual situation]
Why this matters: [explanation]

How should I proceed?
```

## Verification

After each phase:
- Run success criteria checks (`make check test`)
- Fix issues before proceeding
- Check off completed items in plan via Edit
- **Pause for human verification**:
  ```
  Phase [N] Complete - Ready for Manual Verification

  Automated verification passed:
  - [List automated checks that passed]

  Please perform the manual verification steps listed in the plan:
  - [List manual verification items from the plan]

  Let me know when manual testing is complete so I can proceed to Phase [N+1].
  ```

If instructed to execute multiple phases consecutively, skip pause until last phase.

Do not check off manual testing steps until confirmed by user.

## If Stuck

- Read and understand all relevant code first
- Consider if codebase evolved since plan was written
- Present mismatch clearly, ask for guidance
- Use sub-tasks sparingly for targeted debugging only

## Resumable Agents

If plan created by `plan-agent`, resume for clarification:

1. Check `.claude/cache/agents/agent-log.jsonl` for plan-agent entry
2. Use `agentId` to resume:
   ```
   Task(
     resume="<agentId>",
     prompt="Phase 2 isn't matching the codebase. Can you clarify..."
   )
   ```

Available: `plan-agent`, `research-agent`, `debug-agent`

## Resuming Work

If plan has existing checkmarks:
- Trust completed work is done
- Pick up from first unchecked item
- Verify previous work only if something seems off

---

## Agent Orchestration Mode

### Why?

Long implementations accumulate context. Auto-compact mid-task loses context. Agents start fresh, implement one task, create handoff on disk. Handoffs survive compaction.

### Setup

1. Ensure ledger exists (auto-created above)
2. Create handoff directory:
   ```bash
   mkdir -p thoughts/handoffs/<session-name>
   ```
3. Read implementation agent skill:
   ```bash
   cat .claude/skills/implement-task-ho/SKILL.md
   ```

### Pre-Requisite: Plan Validation

Check for validation handoff:
```bash
ls thoughts/handoffs/<session>/validation-*.md
```

No validation → suggest: "This plan hasn't been validated yet. Would you like me to spawn validate-agent first?"

NEEDS REVIEW status → present issues before proceeding.

### Orchestration Loop

```
For each task:
  1. Implement → task handoff created
  2. Review → APPROVED? → Next task
     ↓ CHANGES_REQUESTED
  3. Fix → back to Review (max 3 iterations)
```

#### Step 1: Prepare Context

- Read continuity ledger, plan, previous handoff
- Identify task and testing tier

#### Step 2: Initial Implementation

```
Task(
  subagent_type="general-purpose",
  model="opus",
  prompt="""
  [Paste contents of .claude/skills/implement-task-ho/SKILL.md here]

  ---

  ## Your Context

  ### Continuity Ledger:
  [Paste ledger content]

  ### Plan:
  [Paste relevant plan section or full plan]

  ### Your Task:
  Task [N] of [Total]: [Task description from plan]

  ### Testing Tier:
  [TIER_1 | TIER_2 | TIER_3] - [Reason for tier assignment]

  ### Previous Handoff:
  [Paste previous task's handoff content, or "This is the first task - no previous handoff"]

  ### Handoff Directory:
  thoughts/handoffs/<session-name>/

  ### Handoff Filename:
  task-[NN]-[short-description].md

  ---

  Implement your task and create your handoff.
  """
)
```

Read task handoff created by agent.

#### Step 3: Review Loop

```python
MAX_ITERATIONS = 3
iteration = 1

while iteration <= MAX_ITERATIONS:

  # 3a. Get task-specific git diff
  git_diff = bash("git diff HEAD -- {files_from_handoff}")

  # 3b. Spawn task-review-agent
  review = Task(
    subagent_type="task-review-agent",
    prompt="""
    Review task implementation.

    ## Task Description
    Task {N} of {Total}: {task_description}

    ## Testing Strategy
    Tier: {task_tier}
    Required: {test_requirements_for_tier}

    ## Files Modified
    {files_from_handoff}

    ## Git Diff
    {git_diff}

    ## Previous Review (if any)
    Iteration: {iteration}
    {previous_review_json if iteration > 1 else "First review"}
    """
  )

  # 3c. Read review output
  review_output = read(".claude/cache/agents/task-review-agent/latest-output.md")
  # Parse JSON from output

  # 3d. Check verdict
  if review.verdict == "APPROVED":
    log("Task {N} approved after {iteration} iteration(s)")
    break

  if review.verdict == "CHANGES_REQUESTED":
    if iteration >= MAX_ITERATIONS:
      break  # Will escalate below

    # 3e. Spawn implement-task in fix mode
    Task(
      subagent_type="general-purpose",
      model="opus",
      prompt="""
      [Paste contents of .claude/skills/implement-task-ho/SKILL.md here]

      ---

      ## Fix Mode

      You are in FIX MODE. Address the review comments below.

      ### Review Comments to Fix:
      Iteration: {iteration + 1}

      Comments:
      {format_comments_as_markdown(review.comments)}

      ### Previous Handoff:
      {task_handoff_content}

      ### Handoff Directory:
      thoughts/handoffs/<session-name>/

      ---

      Apply the fixes and update your handoff.
      """
    )

    iteration += 1

# 3f. Handle max iterations exceeded
if iteration > MAX_ITERATIONS and review.verdict != "APPROVED":
  escalate_to_user("""
  Task {N} has unresolved comments after {MAX_ITERATIONS} iterations.

  Remaining issues:
  {format_remaining_must_fix_comments(review.comments)}

  Options:
  1. Continue with remaining issues (accept risk)
  2. I'll fix manually and tell you to resume
  3. Skip this task
  """)
  # Wait for user response before continuing
```

#### Step 4: Finalize Task

After APPROVED (or user accepts with issues):

```python
# Update task handoff with review history
append_to_handoff(task_handoff, """
## Review History
- Iterations: {iteration}
- Final verdict: {verdict}
- Comments addressed: {total_comments_fixed}
""")

# Update ledger (just checkbox)
# IMPORTANT: Only mark complete AFTER review approval
update_ledger_checkbox(task_N, completed=True)

# Continue to next task
```

#### Step 5: On Blocker

Agent returns status="blocked" → read handoff, present blocker to user, options: retry/skip/guidance.

### Comment Formatting

```markdown
### Review Comments to Fix:
Iteration: 2

Comments:
1. [MUST_FIX] src/auth.ts:45 - Missing null check
   Suggestion: Add `if (!user) throw new Error('User required');`

2. [SHOULD_FIX] src/auth.ts:78 - Consider using optional chaining
   Suggestion: Change `user.profile.name` to `user?.profile?.name`

3. [NIT] src/auth.ts:123 - Add JSDoc
   Suggestion: Add documentation comment
```

### Recovery After Compaction

1. Read continuity ledger (loaded by SessionStart hook)
2. List handoffs: `ls -la thoughts/handoffs/<session-name>/`
3. Read last handoff
4. Continue from next uncompleted task

### Handoff Chain

Each agent reads previous handoff → works → creates next:
```
task-01-user-model.md → task-02-auth-middleware.md → task-03-login-endpoint.md → ...
```
Chain preserves context across compactions.

### When to Use Agent Orchestration

| Scenario | Mode |
|----------|------|
| 1-3 simple tasks | Direct |
| 4+ tasks | Agent orchestration |
| Critical context to preserve | Agent orchestration |
| Quick bug fix | Direct |
| User explicitly requests | Respect preference |

### Tips

- Keep orchestrator thin — don't implement yourself, manage agents
- Trust handoffs for context
- One agent per task, sequential execution
- Update ledger only AFTER review approval
- Max 3 review iterations, then escalate to user
- Pass testing tier to implement-task
