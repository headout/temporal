# Log Analysis

Generic log investigation workflow. Service-specific field mappings live in each repo's own investigation overlay (if one exists).

## Inputs

Establish before querying:

- Time window
- Affected service / application name
- Strongest known join key
- Exact symptom or visible error
- Whether you suspect a deploy, config change, or user-specific incident

## Workflow

### 1. Start broad

Gather within the smallest useful time window:

- Error and warning volume
- Repeating messages or message families
- Logger scopes or modules involved
- Restart, timeout, or saturation signals

### 2. Pivot by strongest key

Prefer this order:

1. Session or conversation identifier
2. Request identifier
3. Trace identifier
4. Business identifier (user_id, order_id, or other service-specific keys)
5. Deploy metadata (container version, pod name)

### 3. Build a chronology

For the chosen key:

- Sort logs chronologically
- Identify first bad event
- Identify first downstream effect
- Separate symptom logs from root-cause logs

### 4. Correlate sideways

Use logs to answer:

- Which component first failed
- Whether this is isolated or widespread
- Whether the issue began after a deploy or config change
- Whether the failing request crossed service boundaries

### 5. Hand off to code or traces

Once you know the probable failing step:

- Grep logger scope, message text, or error class in the codebase
- If latency or fan-out is unclear, load `trace-analysis.md`

## Outputs

A useful log investigation produces:

- Strongest join key used
- First bad log line or event family
- Probable failing component or boundary
- Evidence: isolated, widespread, or regression-linked
- Missing information that would most reduce uncertainty

## Common Mistakes

- Searching only `ERROR` and missing important warning/info transitions
- Using a weak key when a stronger session or request key exists
- Assuming the same identifier propagates across services (it often does not)
- Treating deploy coincidence as proof without checking versions
- Stopping at the final exception instead of finding the first causal event

## Graceful Degradation

- If structured fields are poor, pivot by timestamps, logger scope, and message families
- If logs are noisy, narrow the time window first, then add join keys
- If cross-service joins are weak, use service overlays or map business IDs into downstream identifiers
