---
name: cache-ops
description: "Maps a Headout entity to all 5 cache layers (CDN, in-memory pods, Redis, DB/cron) and generates bottom-up invalidation commands with blast-radius assessment. Use when the user says \"clear cache\", \"invalidate cache\", \"flush cache\", \"cdn cache\", \"redis cache\", or \"cache invalidation\"."
allowed-tools: [Read, Glob, Grep, Agent, AskUserQuestion]
---

# Cache Ops

Identify all cache layers affected by an entity or request, then generate bottom-up invalidation commands with blast radius assessment, pre-invalidation checklist, and post-invalidation verification steps.

**This skill is knowledge-only** — it generates commands but never executes them. The engineer reviews and runs each command.

## Before You Start

1. Load `references/cache-architecture.md` for the 5-layer cache topology, Redis instances, CDN distributions, and cron schedules
2. Ensure the `absolut` repo is available locally for dynamic codebase searches

## When to Use

- "clear cache for tourGroupId 12345"
- "invalidate CDN for the calendar API"
- "stale pricing data for TGID 456"
- "how do I flush the collection cache?"
- "Redis cache for city data seems stale"
- "wrong pricing shown to users" (emergency scenario)
- "city page showing empty experiences" (emergency scenario)

---

## Phase 0: Fix the Root Cause FIRST

**CRITICAL RULE: ALWAYS fix the root cause and deploy the fix BEFORE starting any cache invalidation.** Invalidating caches without fixing the code will just re-cache the same wrong data.

Ask the user:

```
Before I generate invalidation commands, I need to confirm:

1. Has the root cause been identified?
   - Code/logic bug → Has the fix been deployed?
   - Data issue in DB → Has the data been corrected in RDS?
   - Stale cron data → Is the cron logic correct but just hasn't run recently?

2. Has the fix been verified?
   - Hit the API endpoint directly (bypassing caches) to confirm correct data

If the fix is NOT yet deployed, stop here. Invalidating now will just
re-cache the same wrong data and cause a thundering herd for nothing.
```

**Exception:** If the data is correct at the source but stale cron data just hasn't propagated yet, you can skip to Phase 1 and trigger the cron.

## Phase 1: Identify the Problem

### Step 1a: Parse the request

Determine the **mode** and **target** from the user's input.

**Mode A: Entity-based** (most common)

| Entity Type | Example Input | How to Detect |
|---|---|---|
| Tour Group | `tourGroupId 12345`, `TGID 12345` | Numeric ID, mentions tour group/TGID/product |
| Tour | `tourId 789` | Numeric ID, mentions tour |
| City | `cityId 42`, `city New York` | Numeric ID or city name |
| Collection | `collectionId 99` | Numeric ID, mentions collection |
| Category/SubCategory | `categoryId 5`, `subcategoryId 12` | Numeric ID, mentions category |
| Media/Image | `mediaId 555`, image URL | Numeric ID or CDN URL |
| URL/API path | `/api/v7/tour-groups/123/calendar` | URL pattern |
| Pricing | `pricing for TGID 456` | Mentions pricing/price + entity |

**Mode B: Layer-based** (surgical)

| Layer | Example Input |
|---|---|
| Redis SyncedCache | "refresh the tour cache in Redis" |
| Redis pricing | "clear pricing cache for TGID 123" |
| Backend CDN | "invalidate backend CDN for this API path" |
| Frontend CDN | "invalidate frontend CDN for this page URL" |
| In-memory / pods | "restart pods to flush in-memory cache" |
| All layers | "nuke all caches for TGID 123" |

### Step 1b: Determine which cache layer is serving stale data

Help the engineer isolate the problem layer:

```
To identify which layer has stale data:

1. Hit the origin directly (bypassing CDN entirely — use the internal Calipso URL):
   curl https://calipso.headout.com/api/v7/tour-groups/{id}

   NOTE: Cache-Control: no-cache in the request does NOT bypass CloudFront.
   CloudFront ignores this header by default. You must hit the origin directly.

   If calipso.headout.com is not reachable from your machine, force a CDN cache
   miss instead (still routes through CloudFront, but fetches fresh from origin):
   curl "https://api.headout.com/api/v7/tour-groups/{id}?_cb=$(date +%s)"
   # CAVEATS:
   # - Only works if query strings are NOT part of the CloudFront cache key.
   #   Check: AWS Console → CloudFront → distribution → Behavior → Cache Key Policy.
   # - Even if CDN is bypassed, the origin may still serve stale in-memory/Redis data.
   #   This only proves the CDN layer, not the full stack. Use Option A for full bypass.

2. Check CDN cache state separately:
   curl -I https://api.headout.com/api/v7/tour-groups/{id}
   - X-Cache: Hit from CloudFront  → CDN is serving cached (possibly stale) data
   - X-Cache: Miss from CloudFront → CDN fetched fresh from origin

3. If the origin returns stale data (step 1):
   → Issue is in Redis or in-memory cache (Layer 3 or 4)

4. If the origin returns correct data but CDN returns stale data (step 1 OK, step 2 stale):
   → Issue is in the backend CDN (Layer 2)

5. If the API returns correct data but the website page shows stale data:
   → Issue is in the frontend CDN (Layer 1)
```

## Phase 2: Assess Blast Radius

Before generating any commands, classify the risk level:

| Scenario | Blast Radius | Risk Level |
|---|---|---|
| Single URL/path is stale | Invalidate that specific path | Low |
| Multiple paths under one domain | Wildcard invalidation | Medium |
| All cached data for a service is wrong | Full cache flush | High |
| Data wrong at source (DB/cron) | Fix source + full flush | Critical |

### Pre-invalidation Checklist (for Medium/High/Critical)

If risk is Medium or higher, include this checklist in the output:

```
PRE-INVALIDATION CHECKLIST:
[ ] Alert the on-call engineer and team lead — post in the relevant Slack incident channel
[ ] Scale up backend pods — increase replica count for affected services
    (after CDN invalidation, all requests hit backend directly until caches warm up)
    kubectl scale deployment/<service> -n <namespace> --replicas=<current * 2>
[ ] Check current RDS connections and CPU — if RDS is already under load, a cache
    flush could push it over. Consider scaling RDS read replicas first.
[ ] Check Redis memory and connections — ensure Redis has headroom for the burst of
    writes during cache repopulation.
[ ] Open monitoring dashboards:
    - Pod CPU/memory
    - RDS connections/CPU/IOPS
    - Redis memory/connections/hit-rate
    - CloudFront error rates
    - Application error rates and latency (p50, p95, p99)
[ ] Plan the invalidation order — always go bottom-up (source of truth first,
    outermost cache last)
```

## Phase 3: Map to Cache Layers & Generate Commands

Dynamically search the `absolut` codebase to find all 5 cache layers affected by the target entity.

**First, locate the absolut repo.** Use the Grep/Glob tools to search in the absolut working directory. If the repo path is not obvious, ask the user.

Use the Grep tool (not Bash) for all codebase searches:

```
# Find SyncedCache keys related to the entity type
Grep: pattern="cache_syncer_" path="<ABSOLUT_ROOT>/tourlandish.calipso/src/" glob="*.{kt,java}"

# Find RedisBackedCache namespaces
Grep: pattern="RedisBackedCache|namespace" path="<ABSOLUT_ROOT>/tourlandish.calipso/src/" glob="*.{kt,java}"

# Find direct Redis key patterns
Grep: pattern="redisTemplate|RedisKey|redis.*put|redis.*set|redis.*delete" path="<ABSOLUT_ROOT>/" glob="*.{kt,java}"

# Find cache-control headers for APIs
Grep: pattern="CacheControl|sMaxAge|maxAge" path="<ABSOLUT_ROOT>/tourlandish.calipso/src/main/kotlin/tourlandish/calipso/api/" glob="*.kt"

# Find cron schedules
Grep: pattern="@Scheduled|@Task|cron" path="<ABSOLUT_ROOT>/tourlandish.calipso/src/" glob="*.{kt,java}"

# Verify Redis hostnames from config
Grep: pattern="redis.*host" path="<ABSOLUT_ROOT>/tourlandish.calipso/src/main/resources/application-production.yml"
```

### Generate commands in BOTTOM-UP order

**The golden rule: always invalidate from the innermost layer outward.** If you invalidate the CDN first, traffic floods the backend with stale in-memory/Redis data — you've amplified the problem.

**Order: Layer 5 (DB/cron) → Layer 4 (Redis) → Layer 3 (in-memory/pods) → Layer 2 (backend CDN) → Layer 1 (frontend CDN)**

---

**Network access note:** All curl commands below assume execution from within the VPN or service mesh (e.g., from a pod or a VPN-connected machine). These internal endpoints are not reachable from the public internet. If auth headers are required for your environment, add them to each curl command.

### Step 4a: Fix DB / Trigger Calipso Cron (Layer 5)

```
LAYER 5: Database (RDS) / Calipso Crons
─────────────────────────────────────────
If data is wrong in DB: fix it in RDS first (with appropriate review and approval).
If cron logic is wrong: fix and deploy first, then trigger manual cron run.
If cron logic is correct but stale: trigger the relevant cron manually.

COMMAND — Trigger full cache recompute:
  curl -X POST https://calipso.headout.com/cache/refresh

COMMAND — Selective cache recompute (choose the appropriate cacheName):
  # ALL_RELOAD  = reload all caches from DB (async, lighter)
  # ALL_RECOMPUTE = full recompute of all caches (sync, heavier)
  # CALIPSO_CURRENCY_CACHE = currency cache only
  # CALIPSO_CURRENCY_CACHE_RELOAD = currency cache reload only
  curl -X POST https://calipso.headout.com/api/cache/recompute \
    -H "Content-Type: application/json" \
    -d '{"cacheName": "ALL_RECOMPUTE"}'

COMMAND — Arceus page/domain cache:
  curl -X POST https://calipso.headout.com/api/v1/page-attribute-service/refresh-cache

COMMAND — City cache:
  curl -X PATCH https://calipso.headout.com/api/v2/cities/cache/refresh

⚠️  BLAST RADIUS: POST /cache/refresh recomputes ALL SyncedCache maps.
    Takes 2-3 minutes. Rate-limited to 1 call per 60 seconds.
    Safe alternative: wait for the next 5-min cron cycle.

Wait for the recompute to complete before proceeding to the next step.
```

### Step 4b: Flush Redis (Layer 4)

```
LAYER 4: Redis
───────────────
Two types of Redis caches exist:

TYPE A — DB-backed (has fallback):
  Delete the key. Next request falls back to DB, fetches fresh data, repopulates Redis.

TYPE B — Cron-only (NO fallback):
  ⚠️  DANGER: If you delete a cron-only key WITHOUT triggering the cron,
  the data will be MISSING until the next scheduled cron run.
  You MUST trigger the Calipso cron (Step 4a) after deleting the key.

⚠️  Verify Redis hostnames before running. Look up current values from:
    grep "redis.*host" <ABSOLUT_ROOT>/tourlandish.calipso/src/main/resources/application-production.yml

COMMANDS — Specific key deletion:
  redis-cli -h {CALIPSO_REDIS_HOST} -p 6379 DEL "tourGrouplistPrice.v4:{id}"
  redis-cli -h {CALIPSO_REDIS_HOST} -p 6379 DEL "seatListPrice.v4:{id}"
  redis-cli -h {CALIPSO_REDIS_HOST} -p 6379 DEL "listing_availability_tgid_{id}"

COMMANDS — Pattern-based deletion:
  redis-cli -h {CALIPSO_REDIS_HOST} -p 6379 --scan --pattern "cache:prefix:*" | xargs -r redis-cli -h {CALIPSO_REDIS_HOST} -p 6379 DEL

COMMANDS — Content Redis (media):
  redis-cli -h {CONTENT_REDIS_HOST} -p 6379 DEL "mediacacheservice::media::{id}"

For bulk media purge, use the canonical media purge script from the internal-scripts
repo. Confirm the checked-out path on your machine, then check usage first:
  python3 <path-to-internal-scripts>/discovery/media_purging.py --help
  # Then run with the appropriate flags, e.g.:
  python3 <path-to-internal-scripts>/discovery/media_purging.py --media-id {id}

⚠️  NEVER run FLUSHDB unless you have explicit approval and have completed the
    pre-invalidation checklist. This wipes ALL keys and will cause widespread outage.

For cron-only caches: after deleting the Redis key, immediately trigger the
Calipso cron to repopulate. Do NOT proceed to the next step until the cron
has completed and you've verified the Redis key contains correct data.
```

### Step 4c: Flush In-Memory Cache / Pod Restart (Layer 3)

```
LAYER 3: In-Memory Cache (pod-level)
──────────────────────────────────────
Each K8s pod maintains its own local in-memory cache (Guava/Caffeine/SyncedCache).
Stale data can persist in some pods even after Redis is cleared.

OPTIONS:
  a) Hit cache/refresh API (triggers recompute + keyspace notification sync):
     ⚠️  If you already ran POST /cache/refresh in Step 4a, SKIP this — that call
     covers both cron refresh and in-memory sync via keyspace notifications.
     It is rate-limited to 1/60s. Only use option (b) if sync isn't propagating.
     curl -X POST https://calipso.headout.com/cache/refresh

  b) Rolling restart of affected pods (more reliable, flushes everything):
     # To be coordinated with platform team
     kubectl rollout restart deployment/<service-name> -n <namespace>
     kubectl rollout status deployment/<service-name> -n <namespace>

Wait for all pods to be healthy before proceeding.
```

### Step 4d: Invalidate Backend CDN (Layer 2)

```
LAYER 2: Backend CDN (CloudFront)
──────────────────────────────────
Domains: api.headout.com, api-ho.headout.com, api-mb.headout.com, www.headout.com (backend origin)
Distribution: verify via AWS Console or chokidar

CloudFront invalidations take 5-15 minutes to propagate globally.

COMMAND — Specific paths (use exact paths to avoid matching other entity IDs):
  aws cloudfront create-invalidation \
    --distribution-id {BACKEND_DISTRIBUTION_ID} \
    --paths "/api/v6/tour-groups/{id}" \
            "/api/v6/tour-groups/{id}/similar" \
            "/api/v6/tour-groups/{id}/reviews" \
            "/api/v6/tour-groups/{id}/poi" \
            "/api/v7/tour-groups/{id}/variants" \
            "/api/v7/tour-groups/{id}/calendar" \
            "/api/v7/tour-groups/{id}/inventory/*" \
            "/api/v7/tour-groups/{id}/poi" \
            "/api/v7/tour-groups/{id}/recommendations"

COMMAND — Wildcard for a city:
  aws cloudfront create-invalidation \
    --distribution-id {BACKEND_DISTRIBUTION_ID} \
    --paths "/api/v3/cities/{cityId}*"

⚠️  AWS charges for invalidations beyond the first 1000 paths/month (free tier).
    Use wildcards wisely — each wildcard counts as 1 path.
```

### Step 4e: Invalidate Frontend CDN (Layer 1)

```
LAYER 1: Frontend CDN (CloudFront)
───────────────────────────────────
Domains: www.headout.com, book.paristickets.com, and all customer-facing frontend URLs
Distribution: verify via AWS Console

COMMAND — Specific product page:
  aws cloudfront create-invalidation \
    --distribution-id {FRONTEND_DISTRIBUTION_ID} \
    --paths "/{city-slug}/{product-slug}*"

COMMAND — Wildcard for a city:
  aws cloudfront create-invalidation \
    --distribution-id {FRONTEND_DISTRIBUTION_ID} \
    --paths "/{city-slug}/*"

Cache behavior varies per URL path. /versailles-palace/ may have a different
TTL than /checkout/. Check the specific distribution's Behaviors tab in AWS Console.
```

## Phase 4: Present the Invalidation Plan

Output a structured summary:

```
## Cache Invalidation Plan for {entity_type} {id}

### Root Cause Status
✅ Fix deployed and verified (or) ⚠️ Stale cron data — cron trigger needed

### Blast Radius: {Low/Medium/High/Critical}

### Layers Affected: {count}

| # | Layer | Type | TTL/Cron | Can Wait? | Action |
|---|---|---|---|---|---|
| 1 | Layer 5: DB/Cron | Source of truth | 5-min cron | Maybe | Trigger cron |
| 2 | Layer 4: Redis | DB-backed / Cron-only | 1h TTL | Maybe | Delete key |
| 3 | Layer 3: In-memory | Pod-level | Pod lifetime | No | Restart pods |
| 4 | Layer 2: Backend CDN | CloudFront | 3m-6h by path | Depends | Invalidate paths |
| 5 | Layer 1: Frontend CDN | CloudFront | Varies by behavior | Depends | Invalidate paths |

### Commands (BOTTOM-UP order — innermost layer first):

1. [Layer 5 command — fix source of truth]
2. [Layer 4 command — flush Redis]
3. [Layer 3 command — flush in-memory / restart pods]
4. [Layer 2 command — invalidate backend CDN]
5. [Layer 1 command — invalidate frontend CDN]

### Can you just wait?

Evaluate whether the data will self-heal:
- Pricing: refreshes in ≤1 hour (TTL) or ≤5 min (cron)
- Listing data: refreshes in ≤5 min (cron)
- Backend CDN: depends on API path (3 min to 48 hours)
- Frontend CDN: depends on URL behavior config

Recommend waiting when TTLs are short enough for the use case.
```

## Phase 5: Verify and Monitor

After the engineer executes the commands, provide verification steps:

```
## Post-Invalidation Verification

1. Curl the affected URL(s) and check that X-Cache: Miss from CloudFront
   appears on the first request (confirms CDN cache was cleared):
   curl -I https://www.headout.com/{path} | grep X-Cache

2. Verify the response data is correct — does it match what's in the database?

3. Confirm caches are warming up — subsequent requests should show
   X-Cache: Hit from CloudFront with correct data.

4. Monitor for 30 minutes minimum — watch for:
   - Spike in backend latency or error rates
   - RDS connection count or CPU spike
   - Redis memory spike
   - Elevated 5xx error rates on CloudFront
   - Application error rate increase
   - p99 latency regression

MONITORING CHECKLIST:
[ ] Pod CPU
[ ] RDS CPU
[ ] RDS connections
[ ] Redis memory
[ ] Redis connections
[ ] CloudFront 5xx rate
[ ] Application error rate
[ ] p99 latency
```

---

## Emergency Scenarios

When the user describes a known emergency pattern, jump directly to the relevant playbook:

### Scenario A: Wrong pricing shown to users (P0 — revenue impact)

```
1. Immediately fix the issue causing wrong pricing
2. Flush the specific Redis pricing key: tourGrouplistPrice.v4:{TGID}
3. Rolling restart the affected pods
4. Invalidate both CDN layers for the product page URL
5. Verify the correct price is showing
6. Post-incident: check if cron-populated caches also need a refresh
```

### Scenario B: Entire city page showing empty experiences (P1 — customer impact)

```
1. Determine root cause: DB issue / cron issue / application issue (Calipso)
2. Correct the issue
3. Scale pods up by 2x BEFORE CDN invalidation
4. Flush Redis keys matching the city pattern
5. Rolling restart pods
6. Invalidate backend CDN with wildcard for the city path
7. Invalidate frontend CDN with wildcard for the city path
8. Monitor RDS and Redis closely for 30 minutes
```

---

## Important Rules

- **Never execute commands** — only generate them. The engineer decides what to run.
- **Always fix root cause first** — invalidating without fixing just re-caches wrong data.
- **Bottom-up invalidation order** — innermost layer first (DB → Redis → pods → backend CDN → frontend CDN). Never CDN first.
- **Cron-only Redis caches have NO fallback** — deleting the key without triggering the cron causes a data outage. Always trigger cron immediately after deleting cron-only keys.
- **Always show blast radius** — especially for `POST /cache/refresh` (recomputes everything) and `FLUSHDB` (wipes all keys).
- **Pre-invalidation checklist for Medium+ risk** — scale pods, check RDS/Redis load, alert on-call, open dashboards.
- **Recommend waiting when possible** — many caches have short TTLs or 5-min cron refreshes.
- **Use dynamic codebase search** — use the Grep tool to verify current key patterns and cache headers before generating commands. Never execute commands via Bash.
- **Redis hostnames may change** — verify from `application-production.yml` before generating commands. No auth password needed for Redis CLI.
- **Frontend CDN vs Backend CDN are separate distributions** — they require separate invalidation commands.
- **Rate limits** — `/cache/refresh` is rate-limited to 1 call per 60 seconds. CloudFront has 1000 free invalidation paths/month.
- **Environment awareness** — always confirm whether the target is production or test. Generate commands for the correct environment.
- **Post-invalidation monitoring** — always include the verification + 30-minute monitoring checklist.
