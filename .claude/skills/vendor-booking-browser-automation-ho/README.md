# vendor-booking-browser-automation

A Claude Code skill that fully automates onboarding a new vendor portal into the Headout
Selenium booking system — from config collection through HTML capture, file generation,
XPath validation, and routing registration.

---

## Table of Contents

1. [Overview](#overview)
2. [Prerequisites](#prerequisites)
3. [How to Invoke](#how-to-invoke)
4. [What the Skill Does — Step by Step](#what-the-skill-does--step-by-step)
   - [Step 1 — Vendor Config](#step-1--vendor-config)
   - [Step 2 — HTML Capture via Playwright](#step-2--html-capture-via-playwright)
   - [Step 3 — Read Reference Files](#step-3--read-reference-files)
   - [Step 4 — Generate 4 Automation Files](#step-4--generate-4-automation-files)
   - [Step 5 — Validate Locators](#step-5--validate-locators)
   - [Step 6 — Register Routing](#step-6--register-routing)
   - [Step 7 — Summary Report](#step-7--summary-report)
5. [Generated Files Explained](#generated-files-explained)
6. [Key Conventions Used in Generated Code](#key-conventions-used-in-generated-code)
7. [After the Skill Completes — Manual Work](#after-the-skill-completes--manual-work)
8. [Out of Scope / Pending Work](#out-of-scope--pending-work)
9. [Edge Cases and Fallbacks](#edge-cases-and-fallbacks)
10. [FAQ](#faq)

---

## Overview

Adding a new vendor to the Selenium system normally requires creating 4 files by hand
(`locators`, `data`, `inventory`, `booking`), reading error code tables, wiring up Celery
tasks, and updating routing. This skill automates all of it.

**Platform:** macOS only (Playwright screenshot tooling uses `screencapture -x`).

---

## Flow Diagram

```
YOU (Developer)                         SKILL (Claude)
───────────────────────────────────────────────────────────────────────

  ┌─────────────────────────────────┐
  │  PREPARATION  (manual)          │
  │                                 │
  │  • vendor_id, tour_ids          │  ← from Selenium pipeline request
  │  • credentials, portal_url      │  ← from JIRA / ops team
  │  • tour_id → product mapping    │  ← from Scorpio product names
  │  • booking_flow steps           │  ← from Zendesk manual instructions
  └──────────────┬──────────────────┘
                 │
                 ▼
        /vendor-booking-browser-automation
                 │
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 1 — Config                ║  auto-derives class_name,
  ║  Load & validate vendor_config  ║  tour_map_constant,
  ║  ── confirm before proceeding ──║  reference_vendor
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 2 — HTML Capture          ║
  ║                                 ║
  ║  🟢 SAFE steps (auto)           ║  Login, Select Date, Enter Pax,
  ║     Playwright navigates &      ║  Fill Details — skill acts alone
  ║     captures HTML               ║
  ║                                 ║
  ║  🔴 DANGER steps  ──────────────╫──► YOU click manually in browser
  ║     Skill stops & waits         ║    (Book / Pay / Confirm / Submit)
  ║     captures HTML after         ║
  ║                                 ║
  ║  ⚠ WAF blocked? ───────────────╫──► YOU paste bookmarklet,
  ║     Falls back to manual flow   ║    send HTML via capture_session.py
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 3 — Read Reference Files  ║  reference vendor booking/
  ║  + data/error_codes.py          ║  locators/ data/ inventory/
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 4 — Generate 4 Files      ║
  ║                                 ║
  ║  locators/  ← XPaths from HTML  ║
  ║  data/      ← URLs, product IDs ║
  ║  inventory/ ← Celery skeleton   ║  ⚠ skeleton only, needs manual impl
  ║  booking/   ← Flow methods      ║    with error codes + Tour globals
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 5 — Validate Locators     ║  validate_locators.py
  ║  (informational, non-blocking)  ║  FOUND / IFRAME / NOT FOUND
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 6 — Register Routing      ║  main/run.py  ← import
  ║                                 ║  data/tour_map.py ← vendor_id const
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ╔═════════════════════════════════╗
  ║  STEP 7 — Summary Report        ║  lists all FILL IN items,
  ║                                 ║  IFRAME / NOT FOUND locators,
  ║                                 ║  manual work checklist
  ╚══════════════╦══════════════════╝
                 ║
                 ▼
  ┌─────────────────────────────────┐
  │  POST-SKILL  (manual)           │
  │                                 │
  │  • Fill # FILL IN stubs         │  base URLs, product IDs
  │  • Fix NOT FOUND locators       │  inspect portal manually
  │  • Implement booking methods    │  use generated locators
  │  • Implement inventory fetch    │  API or Selenium strategy
  │  • Write post-payment script    │  confirmation, ticket URLs
  │  • Test end-to-end              │  run against test booking
  │  • Code review                  │  all 4 files before PR
  └──────────────┬──────────────────┘
                 │
                 ▼
        ┌────────────────┐
        │   Raise PR     │  locators/ data/ inventory/ booking/
        │                │  main/run.py  data/tour_map.py
        └────────────────┘
```

**Legend:**
- `╔═══╗` Automated by skill
- `┌───┐` Manual work by developer
- `🟢` Skill proceeds automatically
- `🔴` Skill stops — you act, skill captures after
- `⚠` Fallback path

---

## Prerequisites

| Requirement | Notes |
|-------------|-------|
| Playwright MCP configured | Used for browser automation in Step 2 |
| Reference vendor files present | Defaults to `np_guinness` if none specified |
| `data/error_codes.py` present | Source of truth for all `SEL_XXXX` constants |
| `tools/validate_locators.py` present | For Step 5 XPath validation |
| `tools/BOOKMARKLET.txt` present | Fallback if Playwright is blocked by WAF |
| Portal credentials | Add `username`, `password`, `portal_url` to `vendor_config.json` |

---

## How to Invoke

```
/vendor-booking-browser-automation
/vendor-booking-browser-automation --site <site_name>
/vendor-booking-browser-automation --config <path/to/vendor_config.json>
```

### Option A — Interactive (no arguments)

```
/vendor-booking-browser-automation
```

The skill will ask: *"What is the site name? (snake_case, e.g. guinness_storehouse)"*
It then looks for an existing `capture_sessions/<site_name>/` folder and loads config
from the most recent timestamp subfolder if found.

### Option B — Site name shortcut

```
/vendor-booking-browser-automation --site melco_entertainment
```

Looks for `capture_sessions/melco_entertainment/<latest-timestamp>/vendor_config.json`
and loads it. If the folder doesn't exist yet, it starts fresh.

### Option C — Direct config path

```
/vendor-booking-browser-automation --config capture_sessions/melco_entertainment/2026-03-09_10-00-00/vendor_config.json
```

Reads the config from the exact path provided. Useful when re-running on a specific
capture session.

---

## What the Skill Does — Step by Step

### Step 1 — Vendor Config

**Goal:** Ensure a complete, confirmed vendor config before any browser interaction.

The skill reads or asks for a `vendor_config.json` with these fields:

| Field | Example | Notes |
|-------|---------|-------|
| `site_name` | `melco_entertainment` | snake_case, used for all filenames |
| `class_name` | `MelcoEntertainment` | PascalCase; auto-derived if absent |
| `vendor_id` | `9876` | Integer; used in inventory constructor and TourMap |
| `tour_ids` | `[12001, 12002]` | List of integers |
| `booking_flow` | `Login > Select Date > Select Time > Enter Pax > Verify > Fill Card > Final Payment > Fetch Reference` | Steps separated by ` > ` |
| `reference_vendor` | `np_guinness` | Existing vendor whose code structure to clone; auto-selected from `booking/` folder based on portal type, falls back to `np_guinness` |
| `tour_map_constant` | `MELCO_ENTERTAINMENT` | SCREAMING_SNAKE_CASE; auto-derived if absent |
| `portal_url` | `https://portal.vendor.com/login` | Used by Playwright to navigate |
| `username` | `headout@vendor.com` | Portal login credential |
| `password` | `secret123` | Portal login credential |

**Auto-derived fields** (the skill fills these in — no need to provide them):
- `class_name` ← PascalCase of `site_name` (2-letter segments become ALL-CAPS, e.g. `np` → `NP`)
- `tour_map_constant` ← `site_name.upper()`
- `reference_vendor` ← scans `booking/` folder and selects the vendor whose portal structure
  (login flow, card-based vs balance-based, step count) most closely matches the new portal;
  falls back to `np_guinness` if no clear match

After loading, the skill shows a summary and asks for confirmation before proceeding:

```
Config loaded:
  site_name:         melco_entertainment
  class_name:        MelcoEntertainment
  vendor_id:         9876
  tour_ids:          [12001, 12002]
  booking_flow:      Login > Select Date > ...
  reference_vendor:  np_guinness
  tour_map_constant: MELCO_ENTERTAINMENT

Proceed? (yes / no)
```

---

### Step 2 — HTML Capture via Playwright

**Goal:** Capture the live HTML of the vendor portal at each booking flow step so that
XPaths generated in Step 4 are grounded in real DOM structure.

#### Session folder

A timestamped folder is created (or reused if it already exists):
```
capture_sessions/melco_entertainment/2026-03-09_10-00-00/
  session_meta.json        ← tracks all captured pages
  1_login.html
  2_select_date.html
  3_select_time.html
  ...
```

#### Safety classification — SAFE vs DANGER

Before touching the browser, the skill classifies every step:

| Zone | Examples | Rule |
|------|----------|------|
| SAFE | Login, Select Date, Select Time, Enter Pax, Fill Customer Details | Skill proceeds automatically |
| DANGER | Book, Confirm, Pay, Submit, Final Payment, Fetch Reference | **Skill always stops and asks you** |

> **Why?** On balance-based portals (no card form), confirming availability can
> automatically deduct credits. The skill never auto-clicks anything that could
> finalise a booking or move money.

When a DANGER step is reached:
```
⚠ DANGER ZONE: I'm about to reach "Final Payment".
  This action may finalise a booking or deduct balance.
  Options:
    1. You click it manually in the browser — I'll capture the HTML after
    2. Skip this page
  Which do you prefer?
```

#### What Playwright does on each SAFE page

1. Takes a snapshot to inspect current state
2. Performs the obvious action (fills login fields, clicks buttons, selects visible options)
3. If judgment is needed (which date to pick, which dropdown option), pauses and asks you
4. Captures `document.documentElement.outerHTML` and saves as `<N>_<label>.html`
5. Updates `session_meta.json`

#### Fallback — manual bookmarklet

If Playwright is blocked by WAF (Cloudflare / AWS WAF detected), the skill falls back:
- Prints the bookmarklet from `tools/BOOKMARKLET.txt` — paste it into your browser
- Runs `python tools/capture_session.py --site <site_name>` to receive the HTML you send

---

### Step 3 — Read Reference Files

The skill reads the following before generating anything:

```
booking/<reference_vendor>.py           ← clones class structure, method bodies
locators/<reference_vendor>_locators.py ← clones staticmethod patterns
data/<reference_vendor>_data.py         ← clones URL/product ID mappings, get_month_map()
inventory/<reference_vendor>_inventory.py ← clones Celery task structure
data/error_codes.py                     ← source of truth for all SEL_XXXX constants
```

If any reference vendor file is missing, the skill warns and falls back to `np_guinness`.

---

### Step 4 — Generate 4 Automation Files

All 4 files are generated in one pass, substituting the reference vendor's class name and
`site_name` with the new vendor's values throughout.

#### 4a. `locators/<site_name>_locators.py`

Contains all XPaths for the vendor portal, extracted from the captured HTML.

XPath selection priority (most stable → least stable):
1. `@id` attribute
2. `@name` attribute
3. `@data-*` custom attributes
4. Unique `@class` (via `contains()`)
5. Text content (`normalize-space()`)

Positional XPaths (`//div[1]`) are avoided unless no alternative exists.

**Dynamic locators** (for date pickers, timeslot lists) are generated as `@staticmethod`
returning an f-string XPath with parameters — matching the reference vendor's pattern exactly.

**Payment iframes:** If card fields are absent from the main DOM but `<iframe>` tags are
present on the payment page, the locator gets a comment:
```python
# PAYMENT IFRAME DETECTED — use driver.switch_to.frame() before accessing this locator
```

#### 4b. `data/<site_name>_data.py`

Contains URL mappings and product ID mappings per `tour_id`:

```python
base_url_tids_mapping       = {12001: "https://...", 12002: "https://..."}
product_id_tids_mapping     = {12001: "PROD-A", 12002: "PROD-B"}
inventory_url_tids_mapping  = {12001: "https://.../availability?date={year}-{month}-{day}"}
```

Values extracted from HTML `<a href>`, `<form action>`, or `data-*` attributes. Where the
portal doesn't expose a value, a `# FILL IN` stub is left for manual completion.

#### 4c. `inventory/<site_name>_inventory.py` *(skeleton only — under development)*

> The inventory file is generated as a **skeleton**. Full fetch logic must be implemented
> manually. See [Out of Scope / Pending](#out-of-scope--pending-work).

Extends `CeleryMixin, BaseInventory`. Strategy auto-detected from HTML:

| HTML pattern | Strategy generated |
|---|---|
| `<ul>/<li>` with `data-*` attributes | HTTP API (requests + BeautifulSoup) |
| No detectable API structure | Selenium strategy skeleton + note in summary |

Six Celery tasks are generated automatically after the class:

```python
@app.task(name='selenium.inventory.melco_entertainment-30-30')
def update_offset_thirty_days_thirty(offset_days, num_days): ...
# ... 5 more tasks with standard offset patterns
```

#### 4d. `booking/<site_name>.py`

Extends `Tour`. One method per `booking_flow` step:

| Flow step | Generated method |
|-----------|-----------------|
| Login | `launch_website()` |
| Select Date | `select_date()` |
| Select Time / Select Time Slot | `select_time_slot()` |
| Enter Pax / Enter Pax Count | `enter_pax_count_and_continue()` |
| Fill Customer Details | `fill_customer_details_and_continue()` |
| Verify | `verify_date_time_slot_and_pax_count()` |
| Fetch Amount | `fetch_amount()` |
| Fill Card / Fill Card Details | `fill_card_details()` |
| Final Payment | `final_payment()` |
| Fetch Reference | `fetch_reference_number_and_send_to_customer()` |
| Anything else | snake_case name + `pass` + `# FILL IN` |

Each method is decorated with `@exception_handler()` using codes looked up from
`data/error_codes.py` — see the [Key Conventions](#key-conventions-used-in-generated-code)
section for the full mapping.

A `book()` orchestrator method is added at the end, calling all methods in sequence.

---

### Step 5 — Validate Locators

```bash
python tools/validate_locators.py \
    --site melco_entertainment \
    --session capture_sessions/melco_entertainment/2026-03-09_10-00-00
```

The validator checks each XPath in the generated locators file against the captured HTML.
Results are informational only — the skill continues regardless of the exit code.

Output in the summary:
```
locators/melco_entertainment_locators.py
  12 locators: 10 FOUND, 1 IFRAME, 1 NOT FOUND
```

---

### Step 6 — Register Routing

#### `main/run.py`

The skill finds the last `from booking.` import line and inserts immediately after it:
```python
from booking.melco_entertainment import MelcoEntertainment
```
Skips silently if the line already exists.

#### `data/tour_map.py`

Finds the last constant inside `class TourMap()` and appends one entry keyed by `vendor_id`:
```python
MELCO_ENTERTAINMENT = {9876: 'MelcoEntertainment'}
```
Skips if a constant with the same `vendor_id` already exists.

---

### Step 7 — Summary Report

```
════════════════════════════════════════════════════════════
  Vendor Booking Browser Automation — Complete
  Site: melco_entertainment  |  Class: MelcoEntertainment
════════════════════════════════════════════════════════════

Generated Files:
  locators/melco_entertainment_locators.py
    12 locators: 10 FOUND, 1 IFRAME, 1 NOT FOUND

  data/melco_entertainment_data.py
    Needs manual fill: base_url for tour_id 12002

  inventory/melco_entertainment_inventory.py
    Strategy detected: HTTP API

  booking/melco_entertainment.py
    8 methods | Reference pattern: np_guinness

Routing Updated:
  main/run.py      — import added (line 47)
  data/tour_map.py — MELCO_ENTERTAINMENT added

Manual Work Remaining:
  [ ] data/melco_entertainment_data.py:12 — FILL IN: base URL for tour_id 12002
  [ ] Verify IFRAME locator: card_number_field
  [ ] Resolve NOT FOUND locator: promo_code_input
  [ ] Review booking method sequence
  [ ] Implement booking method bodies using generated locators
  [ ] Implement inventory fetch logic (skeleton only)
  [ ] Write post-payment script manually
  [ ] Run and test booking script end-to-end
  [ ] Review full generated code before raising PR

Session: capture_sessions/melco_entertainment/2026-03-09_10-00-00
════════════════════════════════════════════════════════════
```

---

## Generated Files Explained

```
locators/melco_entertainment_locators.py    ← XPaths for every portal element
data/melco_entertainment_data.py            ← URLs, product IDs, month maps per tour_id
inventory/melco_entertainment_inventory.py  ← Inventory fetch logic + 6 Celery tasks
booking/melco_entertainment.py              ← Booking flow automation class
```

---

## Key Conventions Used in Generated Code

### Inherited `Tour` globals — never redefine these

The `booking/<site_name>.py` class extends `Tour`, which provides these instance variables
already populated before any method is called:

| Variable | Format | Set by | Used in |
|----------|--------|--------|---------|
| `self.booking_date` | `yyyy-mm-dd` | framework | `select_date()` |
| `self.booking_time` | `HH:MM:SS` | framework | `select_time_slot()` |
| `self.order_amount` | float/str | **you assign** in `fetch_amount()` | fulfillment callback |
| `self.reference_number` | str | **you assign** in `fetch_reference_number_and_send_to_customer()` | fulfillment callback |
| `self.customer_random_email` | str | framework | `fill_customer_details_and_continue()` |

### Card helper methods — never read `self.card` dict directly

| Method | Returns | Typical use |
|--------|---------|-------------|
| `self.get_pan()` | card number | `fill_card_details()` |
| `self.get_cvv()` | CVV | `fill_card_details()` |
| `self.get_full_expiry()` | `MMYY` | most portals |
| `self.get_full_expiry_prado()` | `MM/YY` | portals needing slash separator |
| `self.get_exp_month()` | `MM` | split month/year fields |
| `self.get_exp_year()` | `YY` | split month/year fields |

### `self.zendesk_note_map` — milestone logging

Generated methods log key values at the right moment:
```python
# fill_customer_details_and_continue():
self.zendesk_note_map["used email: "] = self.customer_random_email

# fetch_amount():
self.zendesk_note_map["order amount: "] = self.order_amount

# fetch_reference_number_and_send_to_customer():
self.zendesk_note_map["reference number: "] = self.reference_number
```

### Error code mapping (from `data/error_codes.py`)

| Method | `error_message` | `actionable_exception_type` | `action_to_be_taken` |
|--------|-----------------|-----------------------------|----------------------|
| `launch_website` | `SEL_1010` | `ReautomationRequiredException` | `SEL_7000` |
| `select_date` | `SEL_1100` | `DirtyBookingException` | `SEL_7000` |
| `select_time_slot` | `SEL_1101` | `DirtyBookingException` | `SEL_7000` |
| `enter_pax_count_and_continue` | `SEL_1200` | `ReautomationRequiredException` | `SEL_7000` |
| `fill_customer_details_and_continue` | `SEL_1201` | `ReautomationRequiredException` | `SEL_7000` |
| `verify_date_time_slot_and_pax_count` | `SEL_1202` | `ReautomationRequiredException` | `SEL_7000` |
| `fill_card_details` | `SEL_1320` | `ReautomationRequiredException` | `SEL_7000` |
| `final_payment` | `SEL_1350` | `ManualFetchingRequiredException` | `SEL_7006` |
| `fetch_reference_number_and_send_to_customer` | `SEL_1400` | `ManualFetchingRequiredException` | `SEL_7004` |
| `select_event` / product selection | `SEL_1500` | `ReautomationRequiredException` | `SEL_7000` |
| `select_tour` / category selection | `SEL_1120` | `ReautomationRequiredException` | `SEL_7000` |
| Any unrecognised step | `SEL_0000` | `ReautomationRequiredException` | `SEL_7000` |

---

## After the Skill Completes — Manual Work

The summary lists all `# FILL IN` items. Beyond those, every new vendor requires these
manual steps regardless:

### Preparation (before running the skill)

| Step | Where to get the info |
|------|-----------------------|
| Fill `vendor_config.json` | `vendor_id`, `tour_ids`, `portal_url`, credentials — from the Selenium pipeline request / JIRA ticket |
| Map `tour_id` → portal product | Copy product names from Scorpio; match to portal's product listing |
| Write `booking_flow` | Copy the manual booking steps from Zendesk's manual team booking instructions for this vendor |

### After the skill runs

| Item | Where | What to do |
|------|-------|-----------|
| Base URL for a tour_id | `data/<site_name>_data.py` | Navigate to the booking page for that tour, copy the URL |
| Product ID for a tour_id | `data/<site_name>_data.py` | Find `productId` in portal HTML/network requests |
| Inventory URL template | `data/<site_name>_data.py` | Capture the availability API endpoint |
| NOT FOUND locators | `locators/<site_name>_locators.py` | Inspect the portal manually, provide a stable XPath |
| IFRAME locators | `locators/<site_name>_locators.py` | Add `driver.switch_to.frame()` before using these |
| Method bodies | `booking/<site_name>.py` | Implement each `# FILL IN` using the generated locators |
| DANGER step HTML | captured manually | Navigate DANGER steps yourself in the browser; the skill captures HTML after |
| Post-payment script | new file | Write manually — handles confirmation scraping, ticket URL extraction, etc. |
| Inventory fetch logic | `inventory/<site_name>_inventory.py` | Skeleton only; implement API parsing or Selenium date iteration |
| Test the booking script | local run | Run end-to-end against a test booking; verify reference number and amount are captured correctly |
| Code review | all 4 generated files | Review before raising PR; check locators, error codes, method logic, zendesk_note_map entries |

### What to include in your PR

| Include | Notes |
|---------|-------|
| `locators/<site_name>_locators.py` | Always |
| `data/<site_name>_data.py` | Always |
| `inventory/<site_name>_inventory.py` | Always (even if skeleton) |
| `booking/<site_name>.py` | Always |
| `main/run.py` | Updated by skill |
| `data/tour_map.py` | Updated by skill |
| `capture_sessions/` HTML files | **No** — do not commit captured HTML; add to `.gitignore` |

---

## Out of Scope / Pending Work

The following are **not yet automated** but are planned for future versions of this skill:

| Item | Status |
|------|--------|
| Full inventory automation (API parsing + Selenium date iteration) | Coming soon |
| iframe / shadow root portals — automated frame switching | Coming soon |
| Bot detection portals — automated bypass/retry strategies | Coming soon |
| Post-payment script generation | Coming soon |
| Test file generation | Coming soon |
| Celery beat schedule registration | Coming soon |
| Windows / Linux support | Not planned |
| Automatic locator repair | Not planned |

---

## Edge Cases and Fallbacks

| Scenario | What happens |
|----------|-------------|
| `vendor_config.json` missing fields | Skill asks interactively, writes completed config back |
| Reference vendor files not found | Falls back to `np_guinness`, warns in summary |
| Zero pages captured | Skill stops with a warning; retry from Step 2 |
| Portal blocks Playwright (WAF) | Falls back to manual bookmarklet flow |
| DANGER step reached | **Always stops**, shows snapshot, asks whether you click manually or skip |
| Balance-based portal (no card form) | All steps from pax selection onward treated as DANGER |
| Import already in `main/run.py` | Skipped silently, noted in summary |
| TourMap entry already exists | Skipped silently, noted in summary |
| Re-running on same site | Overwrites 4 generated files; routing entries skipped if duplicate |
| `validate_locators.py` exits with code 2 | Notes "check lxml installation" in summary, continues |
| `class_name` derivation is ambiguous | Proposes a name, asks developer to confirm |

---

## FAQ

**Q: Do I need to provide all fields in `vendor_config.json` upfront?**
No. `class_name`, `tour_map_constant`, and `reference_vendor` are auto-derived.
The skill will ask interactively for anything else it cannot derive.

**Q: What if the portal has WAF protection and blocks Playwright?**
The skill detects this and switches to the manual bookmarklet flow automatically.
If the generated booking file uses Cloudflare/AWS WAF-protected pages, a `# WAF NOTE`
comment is added at the top of the file.

**Q: Can I re-run the skill after the portal changes?**
Yes. Re-running overwrites the 4 generated files. Routing entries in `main/run.py` and
`data/tour_map.py` are skipped if already present.

**Q: What if a booking step isn't in the flow step → method name table?**
The step is converted to snake_case, generated as a stub with `pass` and `# FILL IN`,
and assigned `SEL_0000` / `ReautomationRequiredException`. Fill it in manually.

**Q: How do I pick the right expiry format for a portal?**
- Most portals: `self.get_full_expiry()` → `MMYY`
- Portals with a slash separator: `self.get_full_expiry_prado()` → `MM/YY`
- Portals with split month/year fields: `self.get_exp_month()` + `self.get_exp_year()`
