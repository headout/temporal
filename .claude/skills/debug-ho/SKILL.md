---
name: debug
description: "Debugs a failing issue via logs, database state, and git history to pinpoint the cause and a fix. Use when the user says \"debug this\", \"throwing an error\", \"failing test\", or explicitly asks to debug a bug or crash. Not for production incidents (use investigate)."
---

# Debug

Investigate problems via logs, database state, and git history without editing files. Preserves primary window context.

## Initial Response

With plan/ticket file:
```
I'll help debug issues with [file name]. Let me understand the current state.

What specific problem are you encountering?
- What were you trying to test/implement?
- What went wrong?
- Any error messages?

I'll investigate the logs, database, and git state to help figure out what's happening.
```

Without parameters:
```
I'll help debug your current issue.

Please describe what's going wrong:
- What are you working on?
- What specific problem occurred?
- When did it last work?

I can investigate logs, database state, and recent changes to help identify the issue.
```

## Environment

**Logs**: `./logs/`, `~/.local/share/{app}/`, `/var/log/`
**Database**: Query SQLite with `sqlite3` (check project config for paths)
**Git**: Branch, recent commits, uncommitted changes
**Services**: `ps aux | grep {service}`, `lsof -i :{port}`

## Process

### Step 1: Understand the Problem

1. **Read provided context** (plan/ticket file):
   - What they're implementing/testing
   - Which phase/step they're on
   - Expected vs actual behavior

2. **Quick state check**: branch, recent commits, uncommitted changes, when issue started

### Step 2: Investigate

Spawn parallel Task agents:

```
Task 1 - Check Recent Logs:
Find and analyze the most recent logs for errors:
1. Find latest logs: ls -t ./logs/*.log | head -1 (or project-specific location)
2. Search for errors, warnings, or issues around the problem timeframe
3. Note the working directory if shown
4. Look for stack traces or repeated errors
Return: Key errors/warnings with timestamps
```

```
Task 2 - Database State (if applicable):
Check the current database state:
1. Locate database file (check project config)
2. Connect: sqlite3 {database_path}
3. Check schema: .tables and .schema for relevant tables
4. Query recent data based on the issue
5. Look for stuck states or anomalies
Return: Relevant database findings
```

```
Task 3 - Git and File State:
Understand what changed recently:
1. Check git status and current branch
2. Look at recent commits: git log --oneline -10
3. Check uncommitted changes: git diff
4. Verify expected files exist
5. Look for any file permission issues
Return: Git state and any file issues
```

### Step 3: Present Findings

```markdown
## Debug Report

### What's Wrong
[Clear statement of the issue based on evidence]

### Evidence Found

**From Logs**:
- [Error/warning with timestamp]
- [Pattern or repeated issue]

**From Database** (if applicable):
```sql
-- Relevant query and result
[Finding from database]
```

**From Git/Files**:
- [Recent changes that might be related]
- [File state issues]

### Root Cause
[Most likely explanation based on evidence]

### Next Steps

1. **Try This First**:
   ```bash
   [Specific command or action]
   ```

2. **If That Doesn't Work**:
   - Restart relevant services
   - Check browser console for frontend errors
   - Run with debug flags enabled

### Can't Access?
Some issues might be outside my reach:
- Browser console errors (F12 in browser)
- MCP server internal state
- System-level issues

Would you like me to investigate something specific further?
```

## Rules

- Always require problem description first
- Read files completely (no limit/offset)
- No file editing -- investigation only
- Guide user for out-of-reach issues (browser console, MCP internals)

## Quick Reference

```bash
ls -t ./logs/*.log | head -1
# Or check project-specific log locations
```

```bash
sqlite3 {database_path} ".tables"
sqlite3 {database_path} ".schema {table}"
sqlite3 {database_path} "SELECT * FROM {table} ORDER BY created_at DESC LIMIT 5;"
```

```bash
ps aux | grep {service_name}
lsof -i :{port}
```

```bash
git status
git log --oneline -10
git diff
```
