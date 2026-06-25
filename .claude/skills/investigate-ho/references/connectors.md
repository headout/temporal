# Connectors

Setup and installation reference for each observability connector used by the investigate skill. Once a connector is installed and authenticated, discover its available tools and capabilities dynamically at runtime.

## Coralogix (Logs, Alerts, Incidents, Metrics)

**Interface**: MCP server (`coralogix`)

**Auth**: Connects via API key configured in the MCP server settings. No per-session auth needed if the MCP server is running.

**Verify availability**: Call any Coralogix MCP tool. If it fails, the MCP server is not configured.

**Capabilities**: Log search, trace search, schema discovery, incident management, alert events, metrics queries (PromQL), and built-in documentation for query syntax.

**If not configured**: Ask the user to set up the Coralogix MCP server in their Claude Code MCP settings. They need a Coralogix API key with read permissions.

---

## Datadog (APM, Metrics, Monitors, Incidents)

**Interface**: `pup` CLI (Go binary)

**Install**:
```bash
go install github.com/DataDog/pup@latest
export PATH="$HOME/go/bin:$PATH"
```

**Auth**: OAuth2 browser flow. Ask the user to run `pup auth login` if not authenticated.

**Verify availability**: Run `pup auth status` to check token validity.

**Capabilities**: APM traces, log search, metrics queries, monitor management, incident tracking, deploy events, on-call information. Use `pup --help` and `pup <subcommand> --help` to discover available commands and flags.

**If not installed**: Ask the user to run: `go install github.com/DataDog/pup@latest` then `pup auth login`

---

## Delphi (Codebase Search)

**Interface**: MCP server (`delphi`)

**Auth**: No per-session auth. The MCP server handles it.

**Capabilities**: Code analysis, repo discovery, query classification, internal docs search, and external page fetching. Discover available tools dynamically once the MCP server is connected.

**Tips**:
- Delphi may not reflect the absolute latest code. For critical path verification, prefer local repo access.

**If not configured**: Ask the user to set up the Delphi MCP server.

---

## Langfuse (LLM Traces)

**Interface**: Langfuse CLI or API

**When to use**: Only when the affected service uses LangGraph, LangChain, or other LLM-orchestration frameworks that report to Langfuse.

**Install**:
```bash
pip install langfuse
```

**Auth**: Requires `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, and `LANGFUSE_HOST` environment variables.

**If the user has not set these up**: Ask them to provide the keys or export them in the session.

**Tips**:
- Look for session-scoped or request-scoped traces using service-specific metadata
- Compare `container_img` or deploy metadata across traces for regression detection
- Check for tool/route selection anomalies in LangGraph traces

---

## Local Repository Access

**Interface**: Direct file system access + git

**When to use**: Always preferred over Delphi for code path verification during active investigation.

**If repo not available**: Ask the user to add it with `/add-dir <path>` or fall back to Delphi.
