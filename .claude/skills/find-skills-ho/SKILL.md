---
name: find-skills
description: "Discovers and installs available agent skills that match what the user is trying to do. Use when the user asks \"find a skill for X\", \"is there a skill that can...\", \"what skills are available\", or \"install skill\". Not for authoring a brand-new skill (use skill-developer)."
---

# Find Skills

Discover and install skills from the open agent skills ecosystem.

## When to Use

- "how do I do X" where X might have an existing skill
- "find a skill for X" or "is there a skill for X"
- "can you do X" for specialized capabilities
- User wants to extend agent capabilities or find tools/templates/workflows
- User mentions wanting help with a specific domain (design, testing, deployment, etc.)

## Skills CLI

The Skills CLI (`npx skills`) is the package manager for agent skills — modular packages extending agent capabilities.

**Key commands:**

- `npx skills find [query]` - Search for skills
- `npx skills add <package>` - Install a skill
- `npx skills check` - Check for updates
- `npx skills update` - Update all skills

**Browse:** https://skills.sh/

## How to Help Users

### Step 1: Understand the Need

Identify:
1. Domain (e.g., React, testing, design, deployment)
2. Specific task (e.g., writing tests, creating animations, reviewing PRs)
3. Whether a skill likely exists for this

### Step 2: Search

```bash
npx skills find [query]
```

Examples:
- "how do I make my React app faster?" → `npx skills find react performance`
- "can you help with PR reviews?" → `npx skills find pr review`
- "I need to create a changelog" → `npx skills find changelog`

Results look like:
```
Install with npx skills add <owner/repo@skill>

vercel-labs/agent-skills@vercel-react-best-practices
└ https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
```

### Step 3: Present Options

Show the user:
1. Skill name and purpose
2. Install command
3. Link to learn more

Example:
```
I found a skill that might help! The "vercel-react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.

To install it:
npx skills add vercel-labs/agent-skills@vercel-react-best-practices

Learn more: https://skills.sh/vercel-labs/agent-skills/vercel-react-best-practices
```

### Step 4: Install

If user wants to proceed:

```bash
npx skills add <owner/repo@skill> -g -y
```

`-g` = global (user-level), `-y` = skip confirmation.

## Common Categories

| Category        | Example Queries                          |
| --------------- | ---------------------------------------- |
| Web Development | react, nextjs, typescript, css, tailwind |
| Testing         | testing, jest, playwright, e2e           |
| DevOps          | deploy, docker, kubernetes, ci-cd        |
| Documentation   | docs, readme, changelog, api-docs        |
| Code Quality    | review, lint, refactor, best-practices   |
| Design          | ui, ux, design-system, accessibility     |
| Productivity    | workflow, automation, git                |

## Tips

1. **Use specific keywords**: "react testing" beats just "testing"
2. **Try alternative terms**: If "deploy" fails, try "deployment" or "ci-cd"
3. **Check popular sources**: `vercel-labs/agent-skills`, `ComposioHQ/awesome-claude-skills`

## When No Skills Found

1. Acknowledge no existing skill was found
2. Offer to help directly with general capabilities
3. Suggest creating a custom skill with `npx skills init`

Example:
```
I searched for skills related to "xyz" but didn't find any matches.
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, you could create your own skill:
npx skills init my-xyz-skill
```
