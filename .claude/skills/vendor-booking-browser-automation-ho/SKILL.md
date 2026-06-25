---
name: vendor-booking-browser-automation
disable-model-invocation: true
description: "Onboards a new vendor booking automation end to end — collects config, captures page HTML via a bookmarklet, generates locators/data/inventory/booking files, validates XPaths, and registers routing. Use when the user wants to onboard or add a new vendor, attraction, or site, generate locators, or automate a vendor booking portal. macOS only."
required-paths:
  - booking/
  - locators/
  - data/error_codes.py
---

# Vendor Locator Skill

Complete workflow to onboard new vendor site into Headout Selenium automation:

**config → HTML capture → 4-file generation → XPath validation → routing registration**

**Platform:** macOS only (`capture_session.py` uses `screencapture -x`).

## When to Use

- Adding new vendor/attraction to Selenium automation
- Re-generating automation files after vendor portal changes

## Invocation

```
/vendor-locator [--config <path-to-vendor_config.json>] [--site <site_name>]
```

Examples:
```
/vendor-locator
/vendor-locator --site guinness_storehouse
/vendor-locator --config capture_sessions/guinness_storehouse/2026-02-27_14-00-00/vendor_config.json
```

---

## Workflow

Execute ALL steps below in order.

---

### Step 0 — Validate environment

Verify these paths exist in cwd:

| Path | Purpose |
|------|---------|
| `booking/` | Reference vendor files to clone from |
| `locators/` | Output directory for generated locators |
| `data/error_codes.py` | Source of truth for SEL_XXXX constants |

If **any** missing, stop and print:
```
✗ Wrong repository — vendor-booking-browser-automation requires the Headout Selenium repo.

Missing:
  - <list each missing path>

This skill is only valid in a repository containing booking/, locators/,
data/error_codes.py
```
Do not proceed until all paths present.

---

### Step 1 — Collect and validate vendor config

**Config source:**
- `--config <path>` → read that file
- `--site <site_name>` → find most recent timestamp folder under `capture_sessions/<site_name>/`, load `vendor_config.json`
- Bare invocation → ask site name (snake_case), then look for `capture_sessions/<site_name>/`

**Required fields:**

| Field | Type | Description |
|-------|------|-------------|
| `site_name` | string | snake_case identifier for all filenames |
| `class_name` | string | PascalCase class name for generated classes |
| `vendor_id` | integer | Vendor ID for TourMap and routing |
| `tour_ids` | integer[] | List of tour IDs |
| `booking_flow` | string | Steps separated by ` > ` (e.g. `Login > Select Date > ...`) |
| `reference_vendor` | string | snake_case name of existing vendor to clone from |
| `tour_map_constant` | string | SCREAMING_SNAKE_CASE constant for TourMap |

**Auto-derive missing fields (don't ask if derivable):**
- `class_name` → PascalCase of `site_name`. Split by `_`, capitalize each; 2-letter segments all-caps (`np` → `NP`)
- `tour_map_constant` → `site_name.upper()`
- `reference_vendor` → scan `booking/`, pick vendor with closest portal structure; fallback `np_guinness`

**Ask interactively** for non-derivable fields. Write completed config back to session folder.

**Show config summary and confirm:**
```
Config loaded:
  site_name:         guinness_storehouse
  class_name:        GuinnessStorehouse
  vendor_id:         12345
  tour_ids:          [69197, 69203]
  booking_flow:      Login > Select Date > ...
  reference_vendor:  np_guinness
  tour_map_constant: GUINNESS_STOREHOUSE

Proceed? (yes / no)
```

---

### Step 2 — Playwright-automated HTML capture

Use Playwright MCP tools to navigate portal and capture HTML at each booking flow step.

#### 2a. Set up session folder

Create/reuse: `capture_sessions/<site_name>/<YYYY-MM-DD_HH-MM-SS>/`

Initialize `session_meta.json`:
```json
{
  "site": "<site_name>",
  "captured_at": "<ISO timestamp>",
  "flow_description": "<booking_flow from config>",
  "pages": []
}
```

#### 2b. Safety classification — BEFORE any Playwright interaction

Classify every `booking_flow` step:

| Zone | Label | Description |
|------|-------|-------------|
| 🟢 SAFE | observe / fill | Read-only navigation, form filling — no money moves |
| 🔴 DANGER | commit | Finalises booking or deducts balance/payment |

**DANGER keywords**: Book, Confirm, Pay, Submit, Purchase, Complete, Place Order, Checkout. Any step after "Verify" that isn't read-only. On **balance-based portals** (no card entry): everything from pax selection onward is DANGER.

**Rule: NEVER auto-click DANGER steps.** Always stop and ask:
```
⚠ DANGER ZONE: I'm about to reach "<step name>".
  This action may finalise a booking or deduct balance.
  Options:
    1. You click it manually in the browser — I'll capture the HTML after
    2. Skip this page (capture won't include the confirmation state)
  Which do you prefer?
```

#### 2c. Navigate and capture each page

1. Launch browser: `mcp__playwright__browser_navigate(url=<portal_url>)`
2. Snapshot: `mcp__playwright__browser_snapshot()`
3. **Login** (always SAFE): auto-fill credentials via `mcp__playwright__browser_type()`, click submit, wait for navigation
4. **Capture HTML**: `mcp__playwright__browser_evaluate(function="() => document.documentElement.outerHTML")`
   Save to: `capture_sessions/<site_name>/<timestamp>/<N>_<label>.html`
5. **Each SAFE step**: snapshot → deterministic action → perform directly; judgment needed → pause and ask user
6. **DANGER step**: STOP, show snapshot, ask user per 2b rule
7. Ask if capture complete or additional pages needed

#### 2d. Save session files

Per captured page: HTML file `<N>_<label>.html`, update `session_meta.json`:
```json
{
  "index": N,
  "label": "<step_label>",
  "html": "<N>_<label>.html",
  "screenshot": "(playwright)",
  "html_size_bytes": <byte count>
}
```

#### 2e. Validate capture

If `session_meta.json` pages empty:
```
⚠ No pages captured. Retry from Step 2 or check portal credentials.
```

**Fallback**: If Playwright MCP unavailable or portal blocks automated browsers, fall back to manual bookmarklet: read `tools/BOOKMARKLET.txt`, run `python tools/capture_session.py --site <site_name>`.

---

### Step 3 — Read session data and reference files

Read all HTML files from `session_meta.json`.

Read reference vendor's 4 files:
```
booking/<reference_vendor>.py
locators/<reference_vendor>_locators.py
data/<reference_vendor>_data.py
inventory/<reference_vendor>_inventory.py
```

Read `data/error_codes.py` — single source of truth for `SEL_XXXX` constants. Use in Step 4d for correct codes — never invent codes.

Missing reference file → fallback to `np_guinness`, warn developer.

---

### Step 4 — Generate all 4 automation files

Follow reference vendor's structure **exactly**.

**Universal rules:**
- Substitute reference class name with `class_name`
- Substitute `reference_vendor` with `site_name`
- Never invent XPaths — every XPath grounded in captured HTML
- Use `# FILL IN: <description>` where value can't be extracted

#### 4a. `locators/<site_name>_locators.py`

Class: `<ClassName>Locators` (no base class)
Imports: `from selenium.webdriver.common.by import By`

XPath priority:
1. `@id` → `//tag[@id='value']`
2. `@name` → `//tag[@name='value']`
3. `@data-*` → `//tag[@data-key='value']`
4. Unique `@class` → `//tag[contains(@class, 'unique-class')]`
5. Text → `//tag[normalize-space(text())='text']`

**Never use positional XPaths** (`//div[1]`) unless no other option.

Name by semantic role (`login_email`, `date_picker_button`, etc.).

**Dynamic locators**: elements with `@data-date`/timeslot variations → `@staticmethod` returning `(By.XPATH, f"...")`. Clone signature from reference vendor.

**Payment iframe**: if card fields absent but `<iframe>` present:
```python
# PAYMENT IFRAME DETECTED — use driver.switch_to.frame() before accessing this locator
```

#### 4b. `data/<site_name>_data.py`

Class: `<ClassName>Data` (no base class)
Imports: `import calendar`

Populate:
- `base_url_tids_mapping` → `{tour_id: "booking_url"}` from HTML; stub if absent
- `product_id_tids_mapping` → `{tour_id: "product_id"}` from HTML attributes; stub if absent
- `inventory_url_tids_mapping` → build from product IDs using reference vendor's URL template
- `get_month_map()` → copy verbatim from reference

Multiple `tour_ids` → use `self.tour_id` with `if/else` where values differ.

#### 4c. `inventory/<site_name>_inventory.py`

> **Status: under development.** Skeleton only. Full automation requires manual implementation after generation.

Class: `<ClassName>Inventory(CeleryMixin, BaseInventory)`
Constructor: `__init__(self, tour_id, *args, **kwargs)` with `tour_name="<ClassName>"`, `vendor_id` from config.

**Detect strategy from HTML:**
- `<ul>/<li>` with data attributes → HTTP API pattern
- No API endpoints → Selenium strategy (note manual implementation needed)

Methods: clone structure from reference (`fetch_tour_details`, `fetch_tour_data`, `fetch_vendor_inventory`).

**Celery tasks** — 6 functions after class:
```python
@app.task(name='selenium.inventory.<site_name>-30-30')
def update_offset_thirty_days_thirty(offset_days, num_days): ...

@app.task(name='selenium.inventory.<site_name>-23-7')
def update_offset_twenty_three_days_two(offset_days, num_days): ...

@app.task(name='selenium.inventory.<site_name>-7-16')
def update_offset_seven_days_zero(offset_days, num_days): ...

@app.task(name='selenium.inventory.<site_name>-2-5')
def update_offset_five_days_two(offset_days, num_days): ...

@app.task(name='selenium.inventory.<site_name>-0-2')
def update_offset_two_days_zero(offset_days, num_days): ...

@app.task(name='selenium.inventory.<site_name>')
def main(offset_days, num_days): ...
```

#### 4d. `booking/<site_name>.py`

Class: `<ClassName>(Tour)`

Parse `booking_flow` to derive methods:

| Flow step | Method name |
|-----------|-------------|
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
| Any other step | snake_case name + `pass` + `# FILL IN` |

Each method uses `@exception_handler()` with codes from `data/error_codes.py`. Method body template:
```python
@exception_handler(
    actionable_exception_type=<ExceptionType>,
    error_message=<SEL_CODE>,
    action_to_be_taken=SEL_7000
)
def method_name(self):
    logger.info(f"{self.__class__.__name__}.method_name() - start")
    # FILL IN: implement using <ClassName>Locators
    logger.info(f"{self.__class__.__name__}.method_name() - end")
```

**Inherited globals from `Tour` base class — use these, never redefine:**

| Variable | Type | Value | Where to use |
|----------|------|-------|--------------|
| `self.booking_date` | `str` | `yyyy-mm-dd` | `select_date()` |
| `self.booking_time` | `str` | `HH:MM:SS` | `select_time_slot()` |
| `self.order_amount` | `float/str` | net price | `fetch_amount()` — assign here |
| `self.reference_number` | `str` | booking ref | `fetch_reference_number...()` — assign here |
| `self.customer_random_email` | `str` | random email | `fill_customer_details...()` |

**Card helper methods** (call on `self`, never access `self.card` directly):

| Method | Returns | Use in |
|--------|---------|--------|
| `self.get_pan()` | card number | `fill_card_details()` |
| `self.get_cvv()` | CVV | `fill_card_details()` |
| `self.get_full_expiry()` | `MMYY` | most portals |
| `self.get_full_expiry_prado()` | `MM/YY` | portals needing slash |
| `self.get_exp_month()` | `MM` | split month/year fields |
| `self.get_exp_year()` | `YY` | split month/year fields |

**`self.zendesk_note_map`** — log at these points:
```python
self.zendesk_note_map["used email: "] = self.customer_random_email
self.zendesk_note_map["order amount: "] = self.order_amount
self.zendesk_note_map["reference number: "] = self.reference_number
```
Clone additional keys from reference. Never log raw card data.

---

**Error code + exception type mapping:**

| Method | `error_message` | `actionable_exception_type` | `action_to_be_taken` |
|--------|-----------------|-----------------------------|----------------------|
| `launch_website` | `SEL_1010` | `ReautomationRequiredException` | `SEL_7000` |
| `select_event` | `SEL_1500` | `ReautomationRequiredException` | `SEL_7000` |
| `select_date` | `SEL_1100` | `DirtyBookingException` | `SEL_7000` |
| `select_time_slot` | `SEL_1101` | `DirtyBookingException` | `SEL_7000` |
| `enter_pax_count_and_continue` | `SEL_1200` | `ReautomationRequiredException` | `SEL_7000` |
| `select_tour` | `SEL_1120` | `ReautomationRequiredException` | `SEL_7000` |
| `verify_date_time_slot_and_pax_count` | `SEL_1202` | `ReautomationRequiredException` | `SEL_7000` |
| `fill_customer_details` | `SEL_1201` | `ReautomationRequiredException` | `SEL_7000` |
| `fill_card_details` | `SEL_1320` | `ReautomationRequiredException` | `SEL_7000` |
| `final_payment` | `SEL_1350` | `ManualFetchingRequiredException` | `SEL_7006` |
| `fetch_reference_number...` | `SEL_1400` | `ManualFetchingRequiredException` | `SEL_7004` |
| Any unrecognised step | `SEL_0000` | `ReautomationRequiredException` | `SEL_7000` |

**Do NOT use sequential/invented codes** not in `data/error_codes.py`. Always pick closest match above.

Add `book()` orchestrator calling all methods in sequence (clone from reference).

**WAF detection**: if HTML contains `__cf_chl_` or `aws-waf-token`:
```python
# WAF NOTE: Cloudflare / AWS WAF detected. May require JS execution delays.
```

**Multiple tour IDs**: use `if self.tour_id == <id>: ... elif ...` where behavior differs.

---

### Step 5 — Run locator validation

```bash
python tools/validate_locators.py \
    --site <site_name> \
    --session <session_folder_path>
```

Capture stdout and exit code. Result is informational only — **don't gate on exit code**.

---

### Step 6 — Update routing files

#### `main/run.py`
After last `from booking.` import, insert:
```python
from booking.<site_name> import <ClassName>
```
Skip if identical line exists.

#### `data/tour_map.py`
In `class TourMap()`, after last constant, insert:
```python
    <TOUR_MAP_CONSTANT> = {<vendor_id>: '<ClassName>'}
```
Skip if constant with same `vendor_id` exists. Note skips in summary.

---

### Step 7 — Print summary

```
════════════════════════════════════════════════════════════
  Vendor Locator Skill — Complete
  Site: <site_name>  |  Class: <ClassName>
════════════════════════════════════════════════════════════

Generated Files:
  locators/<site_name>_locators.py
    <N> locators: <found> FOUND, <iframe> IFRAME, <not_found> NOT FOUND

  data/<site_name>_data.py
    Needs manual fill: <list FILL IN fields, or "none">

  inventory/<site_name>_inventory.py
    Strategy detected: <HTTP API | Selenium — manual implementation required>

  booking/<site_name>.py
    <N> methods | Reference pattern: <reference_vendor>

Routing Updated:
  main/run.py      — import added (line <N>) | already present
  data/tour_map.py — <CONSTANT> added        | already present

Manual Work Remaining:
  [ ] <each FILL IN item with file:line>
  [ ] Verify IFRAME locators: <list>
  [ ] Resolve NOT FOUND locators: <list>
  [ ] Review booking method sequence
  [ ] Implement booking method bodies using generated locators
  [ ] Implement inventory fetch logic (skeleton only — see Out of Scope)
  [ ] Write post-payment script manually
  [ ] Run and test booking script end-to-end
  [ ] Review full generated code before raising PR

Session: <session_folder_path>
════════════════════════════════════════════════════════════
```

---

## Edge Cases

| Scenario | Behaviour |
|----------|-----------|
| Config missing fields | Ask interactively; write back before continuing |
| `capture_session.py` not found | Print error + expected path, stop |
| Zero pages captured | Warn and stop |
| Reference vendor files not found | Fall back to `np_guinness`, warn |
| `validate_locators.py` exit 2 | Note "check lxml installation"; continue |
| Import already in `main/run.py` | Skip, note in summary |
| TourMap entry already exists | Skip, note in summary |
| Empty HTML file | Skip page, flag in summary |
| `class_name` derivation ambiguous | Propose name, ask to confirm |
| Re-running on same site | Overwrite 4 files; skip duplicate routing |
| DANGER step reached | STOP, show snapshot, ask user — NEVER auto-click |
| Balance-based portal (no card form) | ALL steps from pax selection onward = DANGER |
| Portal blocks Playwright (WAF/bot) | Fall back to manual bookmarklet |

## Out of Scope

- Windows / Linux support
- Automatic locator repair
- Celery beat schedule registration
- Adding new error codes to `data/error_codes.py`
- Test file generation
- **Inventory automation** — skeleton only; full fetch logic needs manual implementation
- **iframe / shadow root portals** — flagged but not automated
- **Bot detection portals** — fallback to manual bookmarklet only
