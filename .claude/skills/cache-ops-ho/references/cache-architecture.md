# Headout Cache Architecture

> **Staleness warning:** This doc contains production infrastructure details (Redis hostnames, CloudFront distribution IDs, endpoint URLs). These values are snapshots and may drift. **Always verify from source-of-truth configs** (`application-production.yml`, AWS Console, chokidar repo) before using any value in a command. The skill's dynamic codebase search (Phase 3) is the authoritative source — this doc is a structural map for where to look.

---

## 5-Layer Cache Model

Headout's request lifecycle passes through 5 cache layers before reaching the database. Understanding this stack is critical before performing any invalidation.

```
User Request
    ↓
Layer 1: Frontend CDN (CloudFront)
  book.paristickets.com, www.headout.com, www.paristickets.com
  Cache behavior varies per URL path
    ↓ MISS
Layer 2: Backend CDN (CloudFront)
  api.headout.com, api-ho.headout.com, api-mb.headout.com, www.headout.com (backend origin)
  Per-path cache behaviors with different TTLs
    ↓ MISS
Layer 3: In-Memory Cache (pod-level)
  Local cache per K8s pod (Guava / Caffeine / SyncedCache in-memory)
  Each pod has its own copy — stale data can persist even after Redis is cleared
    ↓ MISS
Layer 4: Redis Cache
  Type A: DB-backed (has fallback) — delete key, next request fetches from DB
  Type B: Cron-only (NO fallback) — delete key WITHOUT triggering cron = DATA OUTAGE
    ↓ MISS
Layer 5: Database (RDS) / Calipso Crons
  RDS: source of truth for DB-backed caches
  Calipso crons: source of truth for cron-only caches
```

**Golden rule: invalidate bottom-up** (Layer 5 → 4 → 3 → 2 → 1). If you invalidate CDN first, traffic floods the backend with stale in-memory/Redis data.

## CloudFront Domain Mapping

| Domain | Type | Layer |
|---|---|---|
| `www.headout.com` | Frontend | Layer 1 |
| `book.paristickets.com` | Frontend | Layer 1 |
| `www.paristickets.com` | Frontend | Layer 1 |
| `api.headout.com` | Backend | Layer 2 |
| `api-ho.headout.com` | Backend | Layer 2 |
| `api-mb.headout.com` | Backend | Layer 2 |
| `cdn-imgix.headout.com` | Image CDN | Separate (dist `E2MYKYIK9AGOKS`) |
| `cdn-imgix-open.headout.com` | Public asset CDN | Separate |
| `cdn-s3.headout.com` | S3 CDN (tickets/PDFs) | Separate |

---

## Redis Instances

| Instance | Host (production) | Purpose |
|---|---|---|
| Primary (write) | `calipso-prod-redis.internal.headout.com:6379` | SyncedCache maps, pricing, availability, feature flags, ad-hoc keys |
| Read Replica | `calipso-prod-redis-ro.internal.headout.com:6379` | Read-replica for cache reads, keyspace notification subscriptions |
| Booking Management | `booking-management-redis.internal.headout.com:6379` | Audio guide sessions, DEX/fulfilment, ticket unblur state |
| Content | `content-prod-redis.internal.headout.com:6379` | Media objects, sitemap data, content CDN cache |

Config file: `tourlandish.calipso/src/main/resources/application-production.yml`

**To verify current hostnames:**
```bash
# Manual verification command (run in your terminal, not via the skill):
grep -r "redis" <ABSOLUT_ROOT>/tourlandish.calipso/src/main/resources/application-production.yml | grep "host"
```

---

## Cache Tiers

### Tier A: SyncedCache (in-memory + Redis, full entity maps)

Single Redis key holds the entire map. All Calipso pods hold a copy in memory. Cross-pod sync via Redis keyspace notifications.

**Key format:** `cache_syncer_<cacheKeyName>`

**Invalidation:** Recompute-only (no per-entity delete). Full map is overwritten on each refresh.

**Cron:** `0 */5 * * * *` — every 5 minutes via `CalipsoCacheRefreshService.reloadAllCacheWithEnvCheck()`

**Manual trigger:** `POST /cache/refresh` (rate-limited 1 call/60s)

**Key entities stored:**

| Entity Type | Redis Key | Service File |
|---|---|---|
| Tours | `cache_syncer_mapTourCacheInfo-v1` | `TourCache.kt` |
| Variants | `cache_syncer_mapVariantCacheInfo-v1` | `TourCache.kt` |
| TourGroups | `cache_syncer_mapTourGroups-v4` | `TourCache.kt` |
| City → TGIDs | `cache_syncer_mapCityToTourGroupIds` | `TourCache.kt` |
| City → TourIds | `cache_syncer_mapCityTourIds` | `TourCache.kt` |
| Tag → TourIds | `cache_syncer_mapTagTourIds` | `TourCache.kt` |
| Tag → TGIDs | `cache_syncer_mapTagTourGroupIds` | `TourCache.kt` |
| Categories | `cache_syncer_mapCategoryCache` | `CalipsoCategoryCacheService.kt` |
| SubCategories | `cache_syncer_mapSubCategoryCache` | `CalipsoCategoryCacheService.kt` |
| SubCat+City → TGIDs | `cache_syncer_mapSubCategoryTourGroupsByCity` | `CalipsoCategoryCacheService.kt` |
| Collections | `cache_syncer_mapCollectionCache` | `CalipsoCollectionCacheService.kt` |
| Popular products | `cache_syncer_mapCityToPopularProducts` | `PopularProductsCache.kt` |
| Trending products | `cache_syncer_mapCityToTrendingProducts` | `PopularProductsCache.kt` |
| Popularity score | `cache_syncer_mapProductToPopularityScore` | `PopularProductsCache.kt` |
| Booking count | `cache_syncer_mapProductToBookingCount` | `PopularProductsCache.kt` |

**To find all SyncedCache keys:**
```bash
# Manual verification command (run in your terminal, not via the skill):
grep -rn "cache_syncer_" <ABSOLUT_ROOT>/tourlandish.calipso/src/ --include="*.kt" --include="*.java"
```

### Tier B: RedisBackedCache (per-entity, TTL-based)

One Redis key per entity. Keyspace notifications trigger cross-pod sync.

**Key format:** `<namespace>:<entityId>`

| Namespace | Key Pattern | TTL | Entity |
|---|---|---|---|
| `tourGrouplistPrice.v4` | `tourGrouplistPrice.v4:<TGID>` | 1 hour | Variant listing prices |
| `seatListPrice.v4` | `seatListPrice.v4:<TGID>` | 1 hour | Seatmap listing prices |

**Per-entity delete is possible** via `redis-cli DEL`.

**Config:** `cache.pricing.ttl` in `application.yml` (default 3,600,000 ms = 1 hour)

### Tier C: Direct Redis keys (ad-hoc)

Various services write keys directly. Key patterns vary.

| Key Pattern | TTL | Purpose |
|---|---|---|
| `listing_availability_tgid_<TGID>` | 90 min | Tour group listing availability |
| `arceus::domain::v2:<uid>` | None | Arceus domain attributes |
| `arceus::page:<uid>` | None | Arceus page attributes |
| `cityCache` (Redisson RMapCache) | 600s per entry | All cities |
| `Hub-Reviews` (Spring @Cacheable) | Configured TTL | Hub reviews |
| `recommendation-cluster-tourgroup-<id>` | None | Recommendation clusters |
| `boosters:latest:<tourId>` | None | Inventory boosters |
| `promotion:event:<id>` | None | Promotion events |

### Tier D: Content Redis (separate instance)

| Key Pattern | TTL | Purpose |
|---|---|---|
| `mediacacheservice::media::<mediaId>` | Varies | Media object by ID |
| `mediacacheservice::mediaurltoid::<url>` | Varies | URL → media ID |
| `mediacacheservice::mediaresourceidtourl::<resId>` | Varies | Resource ID → URL |
| `visualsitemapdataservice::visual-sitemap-collections::` | 30 days | Sitemap data |

**Key format convention** (from `RedisKey.kt`): `<className>::<entityName>::<entityId>` (all lowercased)

---

## CDN Layer (CloudFront)

### Distributions

> Distribution IDs below are snapshots — **verify from AWS Console** before use.
> Look up the correct distribution for a domain: AWS Console → CloudFront → search by domain alias.

| Distribution ID | Layer | Domains | Purpose |
|---|---|---|---|
| *Verify in AWS Console* | **Layer 1: Frontend CDN** | `www.headout.com`, `book.paristickets.com`, `www.paristickets.com` | Customer-facing frontend pages |
| *Verify in AWS Console* | **Layer 2: Backend CDN** | `api.headout.com`, `api-ho.headout.com`, `api-mb.headout.com` | Backend API responses |
| `E2NKFVX2O1E6PL` *(verify)* | **Layer 2: Backend CDN** (Discovery) | Discovery API paths on `api.headout.com` | Monitored in chokidar CloudFront alerts |
| `E2MYKYIK9AGOKS` *(verify)* | Image CDN | `cdn-imgix.headout.com` (S3 bucket `tourlandish`) | Media/image assets |
| `E37MLMQ0RUTF3T` *(verify)* | Other | Production push pilot | — |
| `E9EK675GYTGZI` *(verify)* | Other | `developers.headout.com` | Partner docs |

**IAM:** All `Developers` group members have `cloudfront:CreateInvalidation` on `*`.

**How to find the right distribution ID:**
```
# In AWS Console: CloudFront → Distributions → search by domain alias
# Or use AWS CLI:
aws cloudfront list-distributions --query "DistributionList.Items[?contains(Aliases.Items, 'api.headout.com')].{Id:Id,Aliases:Aliases.Items}" --output table
```

### Cache-Control Headers by API

> **Two sources of CDN TTLs exist:**
> 1. **Application-level** — `Cache-Control` / `s-maxage` headers set in Calipso controller code (listed below)
> 2. **CloudFront behavior-level** — TTLs configured in AWS CloudFront distribution Behaviors tab, per URL path pattern
>
> When both are present, CloudFront resolves the TTL as follows:
> - If `s-maxage` < behavior's **Minimum TTL** → CloudFront caches for the **Minimum TTL** (origin is overridden)
> - If Minimum TTL ≤ `s-maxage` ≤ **Max TTL** → CloudFront respects `s-maxage`
> - If `s-maxage` > behavior's **Max TTL** → CloudFront caps at **Max TTL**
>
> When the origin sends no cache headers, CloudFront uses its own behavior-level **Default TTL**.
>
> **Practical implication:** For short-TTL endpoints (e.g., `itinerary-preview` at 10s, live calendar at 3m), always check the behavior's Minimum TTL in AWS Console — the actual CDN stale window may be longer than `s-maxage` suggests.
>
> **The table below only covers application-level headers.** Some APIs (especially frontend page routes, static assets, and partner microsites) have their caching controlled entirely at the CloudFront behavior level with no `Cache-Control` header from the origin. Always check the CloudFront distribution's Behaviors tab for the complete picture.

#### Application-level headers (set in Calipso controllers)

CDN respects `s-maxage`, browsers respect `max-age`.

| API Path Pattern | s-maxage | max-age | File |
|---|---|---|---|
| **v1 APIs** | | | |
| `/api/v1/collections/{id}` | 6h | 4h | `CollectionAPI.kt` |
| `/api/v1/collections/{id}/poi` | 6h | 4h | `CollectionAPI.kt` |
| `/api/v1/persona-affinity/*` | 12h | 1h | `PersonaAffinityApi.kt` |
| **v2 APIs** | | | |
| `/api/v2/categories/{id}` | 6h | 1h | `CategoryApiV2.kt` |
| `/api/v2/sub-categories/{id}` | 6h | 1h | `SubCategoryApiV2.kt` |
| `/api/v2/collections/{id}` | 6h | 1h | `CollectionAPIV2.kt` |
| `/api/v2/collections/{id}/reviews` | 12h | 1h | `CollectionAPIV2.kt` |
| `/api/v2/collections/{id}/qna` | 8h | 4h | `CollectionAPIV2.kt` |
| `/api/v2/collections/{id}/poi` | 6h | 4h | `CollectionAPIV2.kt` |
| `/api/v2/reviews/*` | 12h | 1h | `ReviewApiV2.kt` |
| `/api/v2/persona-affinity/*` | 12h | 1h | `PersonaAffinityApiV2.kt` |
| `/api/v2/poi/{id}` | 6h | 4h | `POIApiV2.kt` |
| **v3 APIs** | | | |
| `/api/v3/cities` (list) | 48h | 4h | `CityApiV3.kt` |
| `/api/v3/cities/{id}` | 6h | 1h | `CityApiV3.kt` |
| `/api/v3/cities/{id}/reviews` | 12h | 1h | `CityApiV3.kt` |
| `/api/v3/cities/{id}/categories/*` | 6h | 1h | `CityCategoryApi.kt` |
| `/api/v3/banners/*` | 6h | 1h | `BannerApiV3.kt` |
| `/api/v3/search/*` | 12h | 6h | `SearchApiV3.kt` |
| **v6 APIs** | | | |
| `/api/v6/tour-groups/{id}` | 21600s (6h) | 3600s (1h) | `TourGroupApiV6.kt` (raw header) |
| `/api/v6/tour-groups/{id}/similar` | 28800s (8h) | 3600s (1h) | `TourGroupApiV6.kt` (raw header) |
| `/api/v6/tour-groups/{id}/reviews` | 24h | 1h | `TourGroupApiV6.kt` |
| `/api/v6/tour-groups/{id}/poi` | 6h | 4h | `TourGroupApiV6.kt` |
| `/api/v6/tour-groups/{id}/itinerary-preview` | 10s | 10s | `TourGroupApiV6.kt` |
| **v7 APIs** | | | |
| `/api/v7/tour-groups/{id}/variants` | 6h | 1h | `TourGroupApiV7.kt` |
| `/api/v7/tour-groups/{id}/calendar` | 10m (std), 3m (live), 30m (seatmap) | same | `TourGroupApiV7.kt` |
| `/api/v7/tour-groups/{id}/inventory` | 3m (std), 30m (seatmap) | same | `TourGroupApiV7.kt` |
| `/api/v7/tour-groups/{id}/poi` | 6h | 4h | `TourGroupApiV7.kt` |
| `/api/v7/tour-groups/{id}/recommendations` | 8h | 4h | `TourGroupApiV7.kt` |
| **Seatmap** | | | |
| `/api/seatmap/view-data/*` | varies | varies | `SeatmapApi.kt` |
| **Search (legacy)** | | | |
| `/api/search/*` | 6h | 3h | `SearchApi.kt` |
| **Internal** | | | |
| `/api/internal/*` | 12h | 1h | `InternalApiController.kt` |
| **Geolocation** | | | |
| `/geolocation/*` | no-cache | — | `GeolocationAPIV4.kt` |

#### CloudFront behavior-level caching (not set in code)

These paths have TTLs configured directly in the CloudFront distribution's Behaviors tab:
- Frontend page routes (`/`, `/{city-slug}/`, `/{city-slug}/{product-slug}/`, `/checkout/`)
- Static assets (`/_next/static/*`, `/static/*`)
- Partner microsite routes (`book.paristickets.com/*`)
- Any path not matched by a specific behavior inherits the distribution's Default Cache Behavior

**To check behavior-level TTLs:** AWS Console → CloudFront → select distribution → Behaviors tab

**To find application-level cache headers:**
```bash
# Search both java and kotlin source trees
grep -rn "CacheControl\|sMaxAge\|maxAge\|s-maxage" <ABSOLUT_ROOT>/tourlandish.calipso/src/ --include="*.kt" --include="*.java" -B3 -A3
```

---

## Invalidation Endpoints

| Endpoint | Method | What it does | Rate Limit |
|---|---|---|---|
| `/cache/refresh` | POST | Recompute ALL SyncedCache maps from DB | 1/60s |
| `/api/cache/recompute` | POST | Recompute by cache name (body: `{cacheName: "<CACHE_NAME>"}`, values: `CALIPSO_CURRENCY_CACHE`, `CALIPSO_CURRENCY_CACHE_RELOAD`, `ALL_RELOAD`, `ALL_RECOMPUTE`) | 1/60s |
| `/api/v2/cities/cache/refresh` | PATCH | Refresh city data | — |
| `/api/v1/page-attribute-service/refresh-cache` | POST | Refresh Arceus domain + page caches | — |
| `/api/v1/visual-sitemap/cache/clear` | GET | Delete visual sitemap Redis hash | — |
| `/api/v1/blog/cache/clear` | POST | Clear blog tag/category cache | — |
| `/expired-tour/invalidate?rmsName=X` | GET | Clear expired vendor tour cache (aries) | — |

**Key files:**
- `CacheController.java` — main `/cache/refresh`
- `CalipsoCacheReloadController.kt` — selective `/api/cache/recompute`
- `PageAttributeServiceController.kt` — Arceus refresh
- `ExpiredTourController.kt` — Aries expired tour cache

---

## Cron Schedules

| Schedule | What it refreshes | File |
|---|---|---|
| Every 5 min | All SyncedCache maps (tours, collections, categories, pricing, availability) | `CalipsoCacheRefreshService.kt` |
| Daily midnight | Popular products, similar products, trending products | `CalipsoCacheRefreshService.kt` |
| Every 5 min | Vendor tour scores | `VendorTourScoreRefresher.kt` |
| Daily midnight | Inventory slot score config | `InventorySlotScoreTourConfigRefresher.kt` |
| Ergo task | All cache recompute (`calipso.event.cache.all.recompute`) | `CalipsoCacheReloadController.kt` |
| Ergo task | Arceus page cache refresh (`calipso.event.arceus_page_cache_refresh`) | `ArceusPageCacheService.kt` |
| Ergo task | Arceus domain cache refresh (`calipso.event.arceus_domain_cache_refresh`) | `ArceusDomainCacheService.kt` |

---

## Entity → Cache Layer Quick Reference

Use this as a starting point, then verify with dynamic codebase search.

| Entity | Redis SyncedCache | Redis Per-Entity | CDN APIs | Cron Refresh |
|---|---|---|---|---|
| TourGroup | `mapTourGroups-v4`, `mapCityToTourGroupIds` | `tourGrouplistPrice.v4:{id}`, `seatListPrice.v4:{id}`, `listing_availability_tgid_{id}` | v6, v7 tour-group endpoints | 5 min |
| Tour | `mapTourCacheInfo-v1`, `mapCityTourIds`, `mapTagTourIds` | — | Via tour group | 5 min |
| City | `mapCityToTourGroupIds`, `mapCityTourIds`, `cityCache` (Redisson) | — | `/api/v3/cities/{id}` (s-maxage=6h) | 5 min + 600s TTL |
| Collection | `mapCollectionCache` | — | `/api/v2/collections/{id}` (s-maxage=6h) | 5 min |
| Category | `mapCategoryCache` | — | Via city/subcategory APIs | 5 min |
| SubCategory | `mapSubCategoryCache`, `mapSubCategoryTourGroupsByCity` | — | `/api/v2/sub-categories/{id}` (s-maxage=6h) | 5 min |
| Pricing | — | `tourGrouplistPrice.v4:{TGID}` (1h TTL) | Calendar/inventory APIs (3-30m) | TTL-based |
| Media | — | `mediacacheservice::media::{id}` (content Redis) | Image CDN (dist `E2MYKYIK9AGOKS`) | None |
| Arceus page | — | `arceus::page:<uid>` | — | Ergo task |
