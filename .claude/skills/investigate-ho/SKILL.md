---
name: investigate
description: "Performs root-cause analysis on a live production incident across Headout services, correlating logs, traces, metrics, and recent changes. Use when investigating a production incident, outage, error spike, latency regression, or a trace ID or Argus alert. Not for local dev failures (use debug)."
allowed-tools: [Bash, Read, Glob, Grep, Agent, AskUserQuestion]
---

# Investigate

Investigate production incidents by correlating logs, traces, metrics, and code to find root cause and recommend mitigation.

## Before You Start

Load `references/connectors.md` for available observability connectors. Verify each connector you plan to use is installed and authenticated. If missing/unauthenticated, prompt user to set up before proceeding.

## Phase 0: Connector Readiness

| Data Source | Connector Type |
|---|---|
| Logs, Alerts, Incidents | Coralogix MCP server |
| APM, Metrics, Monitors | Datadog pup CLI |
| Codebase search | Local repo access or Delphi MCP server |
| LLM Traces | Langfuse (if service uses LLM orchestration) |

If connector fails auth:
1. Tell user which connector failed and why
2. Point to `references/connectors.md` for setup
3. Do not proceed with that data source until auth succeeds

Once available, discover capabilities dynamically — do not assume specific tool names or CLI flags.

## Phase 1: Triage

Extract from user input. Ask only if truly ambiguous (use AskUserQuestion sparingly):

- **Symptom**: what is broken/degraded
- **Service(s)**: which service or product area
- **Time window**: when started or noticed
- **Identifiers**: trace ID, request ID, user ID, error message, Argus link
- **Suspicion**: recent deploy, config change, infra event

Classify severity:

| Level | Meaning |
|---|---|
| P0 | Outage or critical flow unusable |
| P1 | Severe degradation, widespread failures |
| P2 | Partial issue, bounded user set |
| P3 | Low urgency investigation |

## Phase 2: Strategy

Decide data sources and query order. Prefer strongest join key:

1. `request_id` or trace/observation ID
2. Service-specific IDs (order ID, booking ID, user ID)
3. `user_id` or other business IDs
4. Deploy metadata + narrow time window

Plan parallel queries:

| Signal | What to look for |
|---|---|
| **Logs** (Coralogix) | Error/warning volume, repeating messages, logger scopes, restart/timeout signals |
| **APM** (Datadog) | Percentile latency shifts, error rate spikes, resource hot spots, deploy boundaries |
| **Traces** (Langfuse/Datadog) | Latency breakdown, failed spans, route/tool selection, metadata diffs |
| **Code** (local/Delphi) | Error text origin, control flow, dependency wiring, recent changes |
| **Deploy history** | `git log`, container image tags, config changes |

## Phase 3: Gather Signals

Execute strategy. Run independent queries in parallel.

### Logs
Use Coralogix MCP. Load `references/log-analysis.md` for detailed workflow.
- Start broad: error/warning volume in time window
- Pivot by strongest key (session > request > trace > business ID > deploy metadata)
- Build chronology: first bad event, then downstream effects
- Correlate: which component failed first, isolated vs widespread

### APM & Metrics
Use Datadog pup CLI. Discover subcommands via `pup --help` and `pup <subcommand> --help`.
- Error and slow traces for affected service
- Latency, error rates, resource usage metrics
- Recent deploy events and monitor status

### Traces
Load `references/trace-analysis.md` for detailed workflow.
- Pick representative traces (failing, slow, healthy baseline)
- Read metadata before diving into spans
- Find dominant failing/slow span
- Compare good vs bad traces

### Codebase
Local repo: use Grep and Read. Otherwise use Delphi MCP.
If Delphi insufficient, ask: "I need to inspect `<service>` codebase. Can you add the repo directory?"

## Phase 4: Correlate

Build concrete evidence chain:
- Prove which request/session/trace examined
- Map user-facing IDs to internal IDs where service uses different keys
- Compare before/after deploy versions
- Separate first-hit latency from steady-state
- Distinguish infra failure vs application fallback vs bad business logic
- Check if identifier propagates across service boundaries

## Phase 5: Mitigate First

Once problem identified, **advise mitigation before full RCA**:
- Deploy-related: suggest reverting specific build
- Config-related: suggest restoring previous config
- Resource-related: suggest scaling, restart, or circuit-breaking
- Data-related: suggest cache invalidation or manual correction

Present actionable steps user can take now.

## Phase 6: Validate in Code

Deep read of identified code path (trace logic, not just search):
1. Read entrypoint and dependency wiring
2. Trace happy path and failing branch side by side
3. Identify first code decision making bad outcome inevitable
4. Cite exact file paths and line numbers

## Phase 7: RCA Report

Use `assets/rca-template.md` for structure.

Contributing Factors:
1. List all factors
2. Tag each: **trigger** (immediate), **contributing** (pre-existing), or **detection gap** (why not caught earlier)
3. Back every factor with evidence

## Interactive Mode

After findings, remain available for:
- Deeper investigation into specific signals
- Queries with different parameters
- Fix verification after deploy
- Final RCA report generation

## Graceful Degradation

Continue with available connectors:
- No Coralogix: use Datadog for logs/traces + code inspection
- No Datadog: use Coralogix logs/traces + deploy history
- No Langfuse: use logs, APM, source-level tracing
- No Delphi: ask for repo access, or use git history
- No external tools: grep by IDs, inspect code, compare changes via git

## When to Load References

- `references/connectors.md` — start of every investigation
- `references/log-analysis.md` — when investigation depends on structured logs
- `references/trace-analysis.md` — when investigation depends on span trees or latency breakdown
