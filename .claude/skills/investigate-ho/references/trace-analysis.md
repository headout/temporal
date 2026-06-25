# Trace Analysis

Generic trace investigation workflow. Works with Datadog APM, Langfuse, or any span-based tracing system.

## Inputs

Establish before querying:

- Affected service
- Time window
- Strongest known join key
- Whether the issue is latency, failure, wrong route, or missing downstream work
- Whether you need one bad trace, a comparison set, or a deploy regression view

## Workflow

### 1. Pick representative traces

Choose traces that represent one of:

- Known failing request
- Typical slow request
- Healthy baseline request for comparison
- Traces before and after a suspected deploy boundary

### 2. Read metadata first

Before diving into spans, inspect:

- Session or request identifiers
- User or business identifiers
- Environment and deployment metadata
- Route, operation, or tool-selection metadata

### 3. Find the dominant span

Look for:

- The first failing span
- The span with the largest latency contribution
- Missing expected child spans
- New spans that appeared after a regression

### 4. Compare good vs bad

When possible, compare:

- Metadata differences
- Span-tree shape
- Latency distribution across major branches
- Downstream calls present in one trace but absent in the other

### 5. Correlate to logs and code

Use the trace to answer:

- Where the request spent time
- Where control flow diverged
- Which component should be inspected in logs
- Which code path or dependency boundary to read next

If the trace lacks detail, load `log-analysis.md` and pivot using a shared key.

## Outputs

A useful trace investigation produces:

- Representative trace(s) chosen and why
- Metadata keys used for filtering
- Dominant failing or slow span
- Good-vs-bad difference summary
- Likely code path to inspect next

## Common Mistakes

- Reading span trees before checking metadata and trace selection
- Assuming the slowest span is the root cause without comparison
- Using only one bad trace with no healthy baseline
- Ignoring deploy metadata when chasing regressions
- Assuming missing spans mean success rather than missing instrumentation

## Graceful Degradation

- If traces are sparse, use them to find component boundaries, then pivot to logs
- If trace metadata is weak, rely on service-specific docs for the best fields to filter on
- If there is no trace propagation across a boundary, correlate using business IDs and time window
