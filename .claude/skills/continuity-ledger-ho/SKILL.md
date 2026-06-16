---
name: continuity-ledger
description: "Creates or updates a continuity ledger in thoughts/ledgers/ capturing goal, decisions, and phase state so work survives a /clear or compaction. Use when the user says \"continuity ledger\", \"create ledger\", \"before clear\", or \"context almost full\"."
---

# Continuity Ledger

Ledger file that survives `/clear` for long-running sessions. Preserves state within a session (unlike handoffs which are cross-session).

**Why clear over compact?** Compaction is lossy -- after several rounds, context degrades. Clear + reload gives fresh context with full signal.

## When to Use

- Before `/clear`
- Context usage 70%+
- Multi-day implementations or complex refactors
- Sessions expected to hit 85%+ context

## When NOT to Use

- Quick tasks (< 30 min), simple fixes, single-file changes
- Already using handoffs for cross-session transfer

## Process

### 1. Determine Ledger File

```bash
ls thoughts/ledgers/*.md 2>/dev/null
```

- **Exists**: Update it
- **Not found**: `mkdir -p thoughts/ledgers` then create `thoughts/ledgers/<session-name>.md` (kebab-case)

### 2. Create/Update Ledger

```markdown
# Session: <name>
Updated: <ISO timestamp>

## Goal
<Success criteria - what does "done" look like?>

## Constraints
<Tech requirements, patterns to follow, things to avoid>

## Key Decisions
<Choices made with brief rationale>
- Decision 1: Chose X over Y because...
- Decision 2: ...

## State
- Done: <completed items>
- Now: <current focus - ONE thing only>
- Next: <queued items in priority order>

## Open Questions
- UNCONFIRMED: <things needing verification after clear>
- UNCONFIRMED: <assumptions that should be validated>

## Working Set
<Active files, branch, test commands>
- Branch: `feature/xyz`
- Key files: `src/auth/`, `tests/auth/`
- Test cmd: `npm test -- --grep auth`
- Build cmd: `npm run build`
```

### 3. Update Guidelines

**When:** Session start, after major decisions, before `/clear`, at breakpoints, context >70%

**What:** Move completed to "Done", update "Now", add decisions, mark uncertain items UNCONFIRMED

### 4. After Clear Recovery

1. Ledger loads automatically (SessionStart hook)
2. Review UNCONFIRMED items
3. Ask 1-3 targeted questions to validate
4. Update ledger, continue with fresh context

## Template Response

```
Continuity ledger updated: thoughts/ledgers/<name>.md

Current state:
- Done: <summary>
- Now: <current focus>
- Next: <upcoming>

Ready for /clear - ledger will reload on resume.
```

## Tool Comparison

| Tool | Scope | Fidelity |
|------|-------|----------|
| CLAUDE.md | Project | Always fresh, stable patterns |
| TodoWrite | Turn | Survives compaction, understanding degrades |
| Ledger | Session | External file, never compressed, full fidelity |
| Handoffs | Cross-session | External file, detailed context for new session |

## Example

```markdown
# Session: auth-refactor
Updated: 2025-01-15T14:30:00Z

## Goal
Replace JWT auth with session-based auth. Done when all tests pass and no JWT imports remain.

## Constraints
- Must maintain backward compat for 2 weeks (migration period)
- Use existing Redis for session storage
- No new dependencies

## Key Decisions
- Session tokens: UUID v4 (simpler than signed tokens for our use case)
- Storage: Redis with 24h TTL (matches current JWT expiry)
- Migration: Dual-auth period, feature flag controlled

## State
- Done: Session model, Redis integration, login endpoint
- Now: Logout endpoint and session invalidation
- Next: Middleware swap, remove JWT, update tests

## Open Questions
- UNCONFIRMED: Does rate limiter need session awareness?

## Working Set
- Branch: `feature/session-auth`
- Key files: `src/auth/session.ts`, `src/middleware/auth.ts`
- Test cmd: `npm test -- --grep session`
```

## Rules

- Keep concise -- brevity matters for context
- One "Now" item -- forces focus
- UNCONFIRMED prefix -- signals what to verify after clear
- Update frequently -- stale ledgers lose value
- Clear > compact -- fresh context beats degraded
