---
name: jira-workflow
description: "Creates a Jira ticket and a matching git branch from a task description, or picks up an existing ticket. Use when the user wants to create a ticket, set up a feature branch, references a ticket ID like \"PROJ-123\", or says \"start working on\" or \"work on PROJ-456\"."
---

# Jira Workflow

Automates: Jira ticket creation -> status transition -> git branch setup -> plan file creation.

## Prerequisites

Required env vars (echo $ to check, prompt user if missing):
- `JIRA_BASE_URL`        # e.g., https://yourcompany.atlassian.net
- `JIRA_EMAIL`           # Atlassian account email
- `JIRA_API_TOKEN`       # Generate at https://id.atlassian.com/manage-profile/security/api-tokens
- `JIRA_PROJECT_KEY`     # e.g., "PROJ" from PROJ-123
- `JIRA_ASSIGNEE_ID`     # Get via: curl -u email:token "${JIRA_BASE_URL}/rest/api/3/myself" | jq '.accountId'

## Workflow

### Step 0: Detect existing ticket or new task

Check for ticket key pattern `[A-Z]+-\d+` in user input.
- **Found** -> Skip to Step 2 (fetch existing)
- **Not found** -> Step 1 (create new)

### Step 1: Extract ticket details (NEW TICKETS ONLY)

Derive from user description:
- **Summary**: Max 50 chars, imperative mood
- **Description**: 2-4 sentences
- **Status**: Default "Selected for Development"

Present for confirmation before creating.

### Step 2: Create or fetch Jira ticket

#### Option A: Create new ticket

```bash
curl -s -X POST "${JIRA_BASE_URL}/rest/api/3/issue" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{
    "fields": {
      "project": {"key": "'"${JIRA_PROJECT_KEY}"'"},
      "summary": "'"${SUMMARY}"'",
      "description": {
        "type": "doc",
        "version": 1,
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": "'"${DESCRIPTION}"'"}]}]
      },
      "issuetype": {"name": "Task"},
      "assignee": {"id": "'"${JIRA_ASSIGNEE_ID}"'"}
    }
  }'
```

Extract ticket key from response. Then transition:

```bash
curl -s -X POST "${JIRA_BASE_URL}/rest/api/3/issue/${TICKET_KEY}/transitions" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"transition":{"id":"141"}}'
```

ID `141` = "Selected for Development".

#### Option B: Fetch existing ticket

```bash
curl -s "${JIRA_BASE_URL}/rest/api/3/issue/${TICKET_KEY}" \
  -u "${JIRA_EMAIL}:${JIRA_API_TOKEN}" \
  -H "Content-Type: application/json"
```

Extract summary for branch naming.

### Step 3: Create feature branch

```bash
git fetch origin main
git switch -c <ticket-key>-<slug> main 
# Example: GX-123-add-user-auth
```

Format: `{TICKET_KEY}-{slugified-summary}` -- lowercase, hyphens only, max 50 chars.

### Step 4: Suggest implementation changes

If PRD/ERD/spec provided, use subagents for exploration:
1. Analyze requirements
2. Check AGENTS.md / architecture docs
3. Identify affected files/modules
4. Generate numbered change list (files, functions, DB changes, tests)

### Step 5: Save plan file

Create `${TICKET_KEY}-plan.md` in working directory:

```markdown
# ${TICKET_KEY} Plan

## Summary
<summary>

## Description
<description>

## Implementation Changes
<numbered list of changes>
```

## Error Handling

- **Missing env vars**: Prompt user, provide setup instructions
- **Jira API errors**: Parse response, suggest fixes
- **Ticket not found**: Offer to create new one
- **Git errors**: Handle dirty tree, existing branch, no remote

## Examples

**New ticket**: "Add rate limiting to API" -> Creates `PROJ-456`, transitions status, branch `PROJ-456-add-rate-limiting`, generates plan.

**Existing ticket**: "Start working on PROJ-789" -> Fetches "Fix login timeout on mobile", branch `PROJ-789-fix-login-timeout-mobile`, generates plan.

**With context**: "Pick up PROJ-101, here's the ERD" -> Fetches ticket, creates branch, analyzes ERD, generates plan with migration + model changes.
