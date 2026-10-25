# Workbook schema verification record

**Verified:** 2026-10-24
**Source workbook:** `BFF-FRM-06_18_Sample_Test_Log_DRAFT`
**Spreadsheet ID:** withheld from this repository (see "Why identifiers are withheld" below)
**Owner:** a personal Gmail account, not a Bounty Farm Workspace domain — address withheld (see Finding 5)
**Type:** `application/vnd.google-apps.spreadsheet` — native Google Sheet (satisfies PRD §4.3 "convert to a native Google Sheet")
**Created / modified:** 2026-10-24T15:48:04Z / 2026-10-24T15:48:06Z (2s apart — freshly converted, no human edits, no data rows)
**Access method:** authenticated Google Drive read, read-only. **No modification was made to this workbook.**
**Public export probe:** `GET /export?format=xlsx` → **HTTP 401**. The workbook is not link-shared or published.
Satisfies NFR-002 and risk R-10 ("no public sheet publishing").

This record discharges the gate in Master Prompt §3 ("Validate original row-4 header names
from the actual workbook before selecting production Sheet; when names diverge from this
prompt, stop deployment until reconciled") and PRD §4.3 ("Validate all nine existing sheet
titles, every row-4 header and configured bounds before enabling writes").

## Why identifiers are withheld

This repository is public. The verification below was performed against the real
workbook, but the spreadsheet ID and the owner's email address are deliberately not
recorded here.

The spreadsheet is private (a public export request returns HTTP 401), so the ID is not
a credential and knowing it grants no access. It is withheld anyway for two reasons.
First, the application takes `SHEETS_SPREADSHEET_ID` as an Edge Function secret with no
default precisely so that no code path can write to the draft; an ID sitting in the
repository invites someone to paste it into a config "just to test", which is the one
mistake that control exists to prevent. Second, an internal document identifier and a
named individual's address are Bounty Farm's to publish, not this repository's.

Anyone with access to the workbook can confirm every claim below by opening it. The
identifiers live in the operator's own records and in the Edge Function secret store.

## 1. Tab inventory — 9 of 9 verified

| Expected tab | Actual tab | Expected range | Actual range | Verdict |
|---|---|---|---|---|
| `Read me` | `Read me` | A1:E34 | A1:E34 | MATCH |
| `Limits` | `Limits` | A4:I38 | A1:I38 | MATCH |
| `1 Raw materials` | `1 Raw materials` | A:S (19) | A1:S304 | MATCH |
| `2 Ground` | `2 Ground` | A:O (15) | A1:O304 | MATCH |
| `3 Conditioned` | `3 Conditioned` | A:M (13) | A1:M304 | MATCH |
| `4 Pellets` | `4 Pellets` | A:K (11) | A1:K304 | MATCH |
| `5 Extruded soya` | `5 Extruded soya` | A:P (16) | A1:P304 | MATCH |
| `6 Crumble` | `6 Crumble` | A:M (13) | A1:M304 | MATCH |
| `7 Mash` | `7 Mash` | A:K (11) | A1:K304 | MATCH |

Tab names carry a single space after the leading digit (`1 Raw materials`), while the row-1
titles carry two (`1  Raw materials: corn, rice and soya on receipt`). The tab name is the
API addressing key and is encoded exactly in the registry; the row-1 title is prose.

`304` rows confirms the documented 300 prepared recording rows (rows 5–304) and the PRD
NFR-007 requirement that the application must not inherit that ceiling.

## 2. Row-4 header verification — 7 of 7 tabs, 98 of 98 columns, zero divergence

Every row-4 header string below was read from the live workbook and compared character by
character against the PRD §5 column map. **No divergence was found in any tab.** These exact
strings are encoded in `src/forms/registry.ts` as `sheetHeader` and are re-verified at runtime
by `verifyWorkbook()` before any write is permitted.

- **`1 Raw materials` (19):** Sample ID · Date · Time · Material · Supplier · Delivery or lot no. · Truck or container no. · Quantity received (tonnes) · Sampled by · Moisture (%) · Aflatoxin (ppb) · Other mycotoxin tested (name) · Other mycotoxin result · Mould seen? · Insects seen? · Foreign matter seen? · Bad smell? · Tested by (QO) · Comments
- **`2 Ground` (15):** Sample ID · Date · Time · Sampling point · Material or feed type · Batch or bin no. · Sampled by · Mill screen size (mm) · Hammer distance from screen (mm) · Average particle size (µm) · Size spread (GSD) · Moisture (%) at BC · Action taken · Tested by (QO) · Comments
- **`3 Conditioned` (13):** Sample ID · Date · Time · Feed type · Batch no. · Sampled by · Steam pressure reading · Water added (%) · Mash temperature (°C) · Moisture (%) · Action taken · Tested by (QO) · Comments
- **`4 Pellets` (11):** Sample ID · Date · Time · Feed type · Batch no. · Sampled by · Pellet temperature (°C) · Pellet diameter (mm) · Action taken · Tested by (QO) · Comments
- **`5 Extruded soya` (16):** Sample ID · Date · Time · Run no. · Raw soya lot no. · Sampled by · Crusher roller gap (mm) · Steam line (%) · Steam line temperature (°C) · Extruder temperature (°C) · Amount (ton/hr) · Moisture (%) · Urease (pH rise) · Protein solubility (%) · Tested by (QO) · Comments
- **`6 Crumble` (13):** Sample ID · Date · Time · Feed type · Batch no. · Sampled by · Crumbler roll gap (mm) · Moisture (%) · Average particle size (µm) · Pellet durability (PDI, %) · Crumble size (mm) · Tested by (QO) · Comments
- **`7 Mash` (11):** Sample ID · Date · Time · Feed type · Batch no. · Sampled by · Moisture (%) · Average particle size (µm) · Size spread (GSD) · Tested by (QO) · Comments

Note the asymmetry preserved verbatim: `2 Ground` column F is `Batch or bin no.` while tabs
3/4/6/7 use `Batch no.`; `2 Ground` column E is `Material or feed type` while tabs 3/4/6/7 use
`Feed type`. These are not normalised.

## 3. Findings not documented in the PRD or Concept Note

### Finding 1 — Row 3 is a merged group-band row (NEW)

Neither source document mentions it. Row 3 carries merged section bands above the row-4
headers:

| Tab | Row-3 bands |
|---|---|
| `1 Raw materials` | Sample details · Test results · Follow-up |
| `2 Ground` | Sample details · Settings when sampled · Test results · Follow-up |
| `3 Conditioned` | Sample details · Settings when sampled · Test results · Follow-up |
| `4 Pellets` | Sample details · Test results · Follow-up |
| `5 Extruded soya` | Sample details · Settings when sampled · Test results · Follow-up |
| `6 Crumble` | Sample details · Settings when sampled · Test results · Follow-up |
| `7 Mash` | Sample details · Test results · Follow-up |

**Consequences.** (a) The protected header region is **rows 1–4**, not rows 1–3 plus a header
row — any write range must begin at row 5 and the verifier must treat row 3 as immutable.
(b) These bands independently corroborate the PRD §3.2 four-section form layout, and the
registry's `section` grouping is aligned to them rather than invented. Tabs 1, 4 and 7 have
**no** "Settings when sampled" band, which is consistent with those three stages having no
machine-setting fields.

### Finding 2 — A fourth `Limits` status value exists (NEW)

The PRD §7.1 and Concept Note §2 describe three statuses (`To set`, `Set`,
`Confirm with Polinutri`). The live workbook contains a **fourth**:

> Entry 8 · `2 Ground` · After the mill (AM) · Average particle size · µm · Status
> **`To set with Polinutri`** · Note: "850 to 950 µm seen after the feed factory specialist's
> changes, October 2026"

This entry carries an **observed** range (850–950 µm) with no bounds filled into the
Lowest/Highest columns. It is unapproved and must not drive assessment. The specification
importer therefore enumerates four statuses and admits **none** of them as approved.

### Finding 3 — The unconfirmed unit is literal cell data, not an assumption

Entry 13's `Unit` cell contains the literal string **`to confirm`**:

> 13 · `3 Conditioned` · Conditioner setting · Steam pressure · **`to confirm`** · 2.2 · 2.8 ·
> `Set` · "Polinutri visit, 23 October 2026. Unit to confirm, bar or kg/cm²"

So the Master Prompt §3/PRD §5.3 rule "never mark steam pressure conforming while the unit
remains unconfirmed" is enforced by **data**, via an `unitConfirmed: false` flag derived from a
non-dimensional unit string, not by a hardcoded field name. The note narrows the candidate
units to bar or kg/cm². This is the only `Set` entry whose unit is unconfirmed.

### Finding 4 — `Limits` carries a self-declared positional fragility warning

Row 2 of `Limits` reads: "Type limits only in the yellow columns. Leave a cell blank when
there is no limit on that side. **Do not add, delete or move rows, because the test tabs read
these cells by their position.** These are working limits until the specifications in
BFF-MAN-03 sections A1 and C1 are approved."

This is direct evidence for risk R-01 and PRD §7.1's refusal to use row position as a rule
key. It also confirms the legacy conditional-formatting path reads `Limits` by cell position,
so the application's `_Specs`-based engine must run **independently** of that tab rather than
reading it at evaluation time.

### Finding 5 — Workbook is owned by a personal Gmail account

The workbook is owned by a personal Gmail account rather than a Bounty Farm Workspace domain. The address is deliberately not recorded here. This is PRD open
question 1 and bears on risk R-03 and R-10. It does not block the build, but **does** block
production cutover: a quality record of this kind should be owned by a Bounty Farm
organisational identity so that access survives personnel change and can be access-reviewed.
Recorded as blocker **B-07**.

### Finding 6 — `Read me` supplies approved operator vocabulary and sampling frequencies

PRD §11 requires help text to "use production vocabulary from the workbook". The `Read me`
tab supplies it directly, and the registry's `help` strings are taken from it verbatim rather
than paraphrased (µm "one thousandth of a millimetre. Also called GMD"; GSD "How even the
grind is. A higher number means more very big and very small pieces mixed together"; PDI
"How well pellets or crumbles hold together when shaken in the durability tester"; Urease
"How much of the raw soya enzyme is left after extrusion. Too high means the soya is
undercooked"; Protein solubility "Too low means the soya is overcooked").

Sampling frequencies are confirmed as stated in the PRD, and three of seven are genuinely
unset in the source:

| Tab | Frequency in workbook |
|---|---|
| `1 Raw materials` | Every load |
| `2 Ground` | **To set** |
| `3 Conditioned` | **To set** |
| `4 Pellets` | **To set** |
| `5 Extruded soya` | Every run |
| `6 Crumble` | **To set** |
| `7 Mash` | Once per production run |

This is why FR-020 reminders and any sampling-adherence KPI stay disabled: four of seven
stages have no approved frequency, so an "overdue" or "% compliance" figure would be
fabricated. Enforced in code by `frequencyApproved: false`.

`Read me` also confirms the ID code set verbatim — "RM raw material, AM after the mill, BC
before conditioning, AC after conditioning, AP after pelleting, ES extruded soya, CR crumble,
MS mash. Example: RM-261024-01 is the first raw material sample on 24 October 2026" — which
matches the Master Prompt §5 format exactly, including the two-digit sequence.

### Finding 7 — The legacy ID mechanism is date-formula driven

`Read me` step 2: "Type the date first. **The Sample ID fills in by itself.** Write that ID on
the sample bag." This is the A5 formula behaviour the Concept Note §2 flags. Because the
application assigns IDs server-side and atomically, the legacy formula must be cleared from
column A of each operational tab at cutover, and `verifyWorkbook()` fails closed if it detects
a formula in `A5`. Covered by cutover step C-04.

## 4. Verification verdict

| Gate | Result |
|---|---|
| Nine tab names match | **PASS** |
| Row-4 headers match, all 98 columns | **PASS** |
| Column counts/ranges match | **PASS** |
| Workbook is native Google Sheet | **PASS** |
| Workbook not publicly shared | **PASS** |
| `Limits` usable as an approved ruleset | **FAIL — by design.** 0 of 34 entries approved |
| Workbook owned by organisational identity | **FAIL — blocker B-07** |
| Safe as a write target | **NO — this is the DRAFT.** See below |

**This workbook is the verified schema source, not the write target.** PRD §4.3 requires a
separately named controlled copy for testing while "the uploaded draft [is] preserved
unchanged". The application therefore takes `SHEETS_SPREADSHEET_ID` as a privileged Edge
Function secret with **no default value**, and this draft's ID is recorded here as evidence
only. It is deliberately absent from `.env.example`, all source code and all test fixtures, so
no misconfiguration can cause a write to the draft.

## 5. Specification import: 34 entries, 0 approved

Imported into `specification_versions` as `status='reference_only'` with
`approved_by = NULL`, so none can drive an assessment. Verbatim from the live `Limits` tab:

| # | Tab | Sample | Test | Unit | Low | High | Status |
|---|---|---|---|---|---|---|---|
| 1 | 1 Raw materials | Corn | Moisture | % | | | To set |
| 2 | 1 Raw materials | Rice | Moisture | % | | | To set |
| 3 | 1 Raw materials | Soya | Moisture | % | | | To set |
| 4 | 1 Raw materials | Corn | Aflatoxin | ppb | | | To set |
| 5 | 1 Raw materials | Rice | Aflatoxin | ppb | | | To set |
| 6 | 1 Raw materials | Soya | Aflatoxin | ppb | | | To set |
| 7 | 2 Ground | Hammer mill setting | Hammer distance from screen | mm | | | To set |
| 8 | 2 Ground | After the mill (AM) | Average particle size | µm | | | **To set with Polinutri** |
| 9 | 2 Ground | After the mill (AM) | Size spread (GSD) | | | | To set |
| 10 | 2 Ground | Before conditioning (BC) | Average particle size | µm | | | To set |
| 11 | 2 Ground | Before conditioning (BC) | Size spread (GSD) | | | | To set |
| 12 | 2 Ground | Before conditioning (BC) | Moisture | % | | | To set |
| 13 | 3 Conditioned | Conditioner setting | Steam pressure | **to confirm** | 2.2 | 2.8 | Set |
| 14 | 3 Conditioned | Conditioner setting | Water added | % | 0.5 | 1 | Set |
| 15 | 3 Conditioned | Mash after conditioning | Temperature | °C | 84 | 86 | Set |
| 16 | 3 Conditioned | Mash after conditioning | Moisture | % | | | To set |
| 17 | 4 Pellets | Pellets before crumbling | Temperature | °C | | | To set |
| 18 | 4 Pellets | Pellets before crumbling | Pellet diameter | mm | | | To set |
| 19 | 5 Extruded soya | Extruder setting | Crusher roller gap | mm | | | To set |
| 20 | 5 Extruded soya | Extruder setting | Steam line | % | | | To set |
| 21 | 5 Extruded soya | Extruder setting | Steam line temperature | °C | | | To set |
| 22 | 5 Extruded soya | Extruder setting | Extruder temperature | °C | | | To set |
| 23 | 5 Extruded soya | Extruder setting | Amount | ton/hr | | | To set |
| 24 | 5 Extruded soya | Extruded soya | Moisture | % | | | To set |
| 25 | 5 Extruded soya | Extruded soya | Urease | pH rise | 0.05 | 0.20 | Confirm with Polinutri |
| 26 | 5 Extruded soya | Extruded soya | Protein solubility | % | 70 | 85 | Confirm with Polinutri |
| 27 | 6 Crumble | Crumbler setting | Roll gap | mm | 1.2 | 1.8 | Set |
| 28 | 6 Crumble | Finished crumble | Moisture | % | | | To set |
| 29 | 6 Crumble | Finished crumble | Average particle size | µm | | | To set |
| 30 | 6 Crumble | Finished crumble | Pellet durability (PDI) | % | | | To set |
| 31 | 6 Crumble | Finished crumble | Crumble size | mm | | | To set |
| 32 | 7 Mash | Finished mash | Moisture | % | | | To set |
| 33 | 7 Mash | Finished mash | Average particle size | µm | | | To set |
| 34 | 7 Mash | Finished mash | Size spread (GSD) | | | | To set |

**Status tally:** 27 `To set` · 4 `Set` · 2 `Confirm with Polinutri` · 1 `To set with Polinutri`.

**Approved for release assessment: 0 of 34.** Every measurement therefore assesses as
`Not Assessable` until a Quality Supervisor approves a rule in `_Specs`. The four `Set`
entries are reference values from a vendor visit, not Bounty Farm approvals; one of them
(#13) additionally lacks a unit. Two await Polinutri confirmation. The 84–86 °C rule in
UAT-06 is seeded **only** into the test fixture, never into production seed data.

Four of the 34 entries describe **machine settings** (#7, #13, #14, #19–23, #27), not sample
test results. A setting outside a working range is a process-control signal, not a product
conformity decision, and the two must not be conflated when a rule is eventually approved.
Flagged for the process owner as decision **D-09**.
