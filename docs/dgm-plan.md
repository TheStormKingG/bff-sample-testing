# DGM (granulometry) — implementation plan

**Status: DRAFT FOR YOUR REVIEW. Nothing has been built.**
Read §2 first. Four decisions there change what gets built; the rest of the
plan is written assuming answers that you may well want to change.

Source: `Cópia de DGM (2).xls`, Poli-Nutri Alimentos, created 2005, last saved
2019-08-19. Three sheets: `DGM_DPG` (the worked example), `FORM` (a blank
four-up capture sheet), `Sieve` (an ABNT/Tyler/mm conversion table credited to
CBAA, 1998).

---

## 1. What the spreadsheet actually computes

Decompiled from the file's own formula records, not inferred from the numbers.
Every line below was reproduced exactly against the worked example (202 g of
"BF", 7 Aug 2019).

| Cell | Formula | Meaning |
|---|---|---|
| `E` | `D − C` | sample retained on sieve = (sieve+sample) − empty sieve |
| `F` | `E × 100 / E17` | **R%** — that sieve's share of total retained mass |
| `H` | `F × G` | R% × Kj |
| `G20` | `H17 / 100` | **MF**, Fineness Module |
| `G22` | `104.14 × 2^G20` | **DGM**, micrometres |
| `G25/26/27` | `SUM(F10:F11)/10`, `SUM(F12:F14)/10`, `SUM(F15:F16)/10` | **UI** coarse / average / fine, in units out of 10 |
| `G29` | `STDEV(A31:A37)` | **DPG** |
| `A31:A37` | `Eᵢ × Bᵢ / 10000` | mass × aperture ÷ 10 000 |

The default series, and the `Kj` weights:

| Position | ABNT | Aperture (µm) | Kj | UI group |
|---|---|---|---|---|
| 1 | 5 | 4000 | 6 | coarse |
| 2 | 10 | 2000 | 5 | coarse |
| 3 | 16 | 1200 | 4 | average |
| 4 | 30 | 600 | 3 | average |
| 5 | 50 | 300 | 2 | average |
| 6 | 400 | 38 | 1 | fine |
| 7 | Fundo (pan) | 37 | 0 | fine |

Worked example reproduced to 15 decimal places: MF 3.821782178217822,
DGM 1472.6130536938736, UI 22.77 / 77.23 / 0.00, DPG 4.520676308442608.

The sheet also records, beside the table: date, description, RPM, Hz/position,
and grind time. The `FORM` sheet captures four configurations at once — Corn
Fine, Corn Coarse, Rice Fine, Rice Coarse — which suggests a DGM *session* is
normally several samples, not one.

---

## 2. Four things to decide before anything is built

These are not implementation details. Each one changes the shape of the
feature, and three of them are defects in the source spreadsheet rather than
questions of taste.

### 2.1 `DGM` ignores the sieve apertures entirely — and you want them editable

`Kj` is `6,5,4,3,2,1,0` assigned **by position in the stack**, never derived
from the aperture. So `MF`, `DGM` and `UI` depend only on *how mass
distributes across seven positions* — not on what those sieves actually are.

Swap the 1200 µm sieve for a 1000 µm one and, for the same weights, the app
would report an identical DGM. That is physically wrong, and `104.14` is an
empirical constant calibrated to this exact series.

So requirement 2 — "change the sieve sizes or select a preset" — is in direct
conflict with the formula as written. Three ways out:

- **(a) Presets only, formula untouched.** Sieve sizes are a *labelled
  configuration* chosen from a list; the default is the one above. Editing
  individual apertures is not offered. Honest, smallest, and the result stays
  comparable with every historical record. Changing the stack means adding a
  new preset, which is a deliberate act.
- **(b) Editable apertures, formula generalised.** Replace `Kj`-by-position
  with a real log-based computation over actual apertures (ASAE S319 is the
  usual reference). Physically correct for any stack — and it will **not**
  reproduce your historical numbers, because it is a different calculation.
- **(c) Editable apertures, formula untouched, and say so.** Store the
  apertures for the record, compute as today, and state on screen that MF/DGM
  assume the standard series. I would argue against this: it prints a number
  that looks comparable and is not.

**My recommendation: (a) now, with the stored data shaped so (b) remains
possible later.** Store every aperture with every sample regardless, so a
recomputation is possible if you later decide the maths should change.

**Your decision:** ______________________

### 2.2 `DPG` is not a geometric standard deviation, and it moves with sample size

`STDEV(A31:A37)` over `mass × aperture ÷ 10000` is a *sample* standard
deviation across seven bins, including the empty ones as zeros. Measured:

```
sample mass ×1   -> DPG = 4.5207
sample mass ×2   -> DPG = 9.0414
sample mass ×10  -> DPG = 45.2068
```

Two identical grinds give different "DPG" if one used twice the sample. It
also carries units (g·µm/10⁴), where a geometric standard deviation is
dimensionless. For contrast, a real GSD on this same sample is **1.67**.

- **(a) Reproduce it exactly**, so the app agrees with every historical
  record, and label it something that is not "standard deviation" — it is an
  index, not a statistic.
- **(b) Compute a real GSD** and accept that it will not match the old sheet.
- **(c) Show both**, clearly distinguished.

**My recommendation: (c), with the spreadsheet's value labelled as the legacy
index and the real GSD shown beside it.** You lose nothing and stop
propagating a number that cannot be compared between samples of different
mass.

**Your decision:** ______________________

### 2.3 The two bottom sieves are 38 µm and 37 µm

The `Sieve` reference table in the same workbook says ABNT 400 = 0.037 mm =
**37 µm**, and marks it `*-Prato` — the pan. The `DGM_DPG` sheet uses 38 µm for
ABNT 400 and 37 µm for `Fundo`, i.e. two rows one micrometre apart, one of
which is the pan counted twice.

It makes no numerical difference while both are zero, which they are in the
worked example. It matters the moment fines are retained. Ask the lab what is
physically in the stack: a 400-mesh sieve *and* a pan, or just a pan?

**Your decision:** ______________________

### 2.4 Is a DGM test one sample, or a session of several?

The `FORM` sheet captures four at once (Corn Fine/Coarse, Rice Fine/Coarse).
If a run is normally four grinds compared side by side, then "one row per
test" stores it, but the *comparison* — which is the point of the exercise —
lives nowhere.

- **(a) One row per sample.** Simple, matches the other seven tabs. Comparison
  is done by reading several rows.
- **(b) One row per sample plus a session identifier**, so the four are
  linkable and can be shown together.

**My recommendation: (a) with a free-text run/batch reference**, which costs
nothing now and makes (b) possible later without migrating data.

**Your decision:** ______________________

---

## 3. Shape of the thing

Assuming 2.1(a), 2.2(c), 2.4(a).

### 3.1 What one DGM record holds

**Identity and context** — the same spine as the other seven stages: sample id,
date, time, sampled by, material/description, plus the process settings the
sheet already records (RPM, Hz/position, grind time).

**Per sieve, seven times** — ABNT label, aperture µm, empty sieve mass,
sieve+sample mass. The aperture is stored *with the sample*, not only in a
config table, so the record is reproducible years later even if the preset
changes.

**Derived** — retained mass and R% per sieve; MF; DGM; UI coarse/average/fine;
DPG (legacy) and GSD (real). Derived values are **computed on the server** and
stored, never sent as Sheets formulas: the writer uses `valueInputOption=RAW`
precisely so an operator's `=` cannot become a live formula, and a stored
number is what makes the record auditable.

### 3.2 The sheet tab

An eighth tab, `8 DGM`, one row per test, same four-row header convention as
the others so the existing header verification and drift latch apply
unchanged. Roughly 45 columns: ~8 identity, 7×4 sieve, ~8 derived.

Wide, but flat — which is what keeps it inside the machinery that already
works.

### 3.3 The form

The generated `StageForm` renders a flat list of fields. A sieve stack is a
repeating group of seven rows × two inputs. **Expect this to need its own
component** rather than a registry extension — but it must reuse, not
reimplement: uncontrolled inputs (so `12.50` keeps its trailing zero), the
error summary, the section bands, the `aria` wiring, 44 px targets, the sticky
footer, and the server-issue routing added this week.

On a phone a 7×2 table will not fit as a table. It should degrade to seven
labelled cards, one per sieve, each with two inputs.

### 3.4 The results view

After submit, show the computed table — the same shape as the spreadsheet's
output block, because that is what the lab already reads. Live totals *while
typing* are worth having (the operator catches a mis-keyed mass immediately),
with the authoritative values coming back from the server on save.

---

## 4. Work, in order

**The order below is not a preference. Getting it wrong can fence the Sheets
writer for all eight stages with no way to clear it — see §7.1.**

1. **Settle §2 and §7.2.** Nothing below is safe to start first.
2. **Author the `8 DGM` tab in the workbook, by hand.** Before any code. The
   app cannot create a tab or write a header row — the Sheets adapter has no
   `addSheet` and no `batchUpdate` at all (verified: zero occurrences). A
   person creates the tab and types row 4 exactly.
3. **Read the header strings back from that tab** and only then write the
   registry entries, character for character, the way the other seven were.
4. **Pin the maths in tests.** Encode the worked example as a fixture and
   assert every output to the sheet's own precision. This is the spec; it
   fails until the implementation matches.
5. **Database** — the eighth stage. Includes dropping and re-adding the
   ordinal constraint (§7.2) and choosing a two-letter prefix.
6. **Registry and schema** — field set, validation, sheet mapping, with the
   existing contract gates extended to the new stage.
7. **Verify the tab** with `schema-verify` before any write is attempted.
8. **Server** — validation mirror and the derived-value computation, with the
   step-4 fixture run against the *server's* implementation too.
9. **Form** — the sieve-table component, phone layout first.
10. **Results** — the computed table on confirmation and on sample detail.
11. **End-to-end on the live stack**, through the real form.

---

## 5. What this plan deliberately does not do

- **No acceptance limits.** 0 of 34 workbook limits are approved, and a DGM
  result will be recorded and shown without a pass/fail judgement until a
  process owner approves one. Nothing here may imply a limit exists.
- **No change to the other seven stages.**
- **No live formulas in the workbook.** Derived values are written as numbers.
- **No silent reinterpretation of historical data.** Whatever is decided in
  §2.1 and §2.2, old records keep meaning what they meant.

---

## 7. What the code actually requires

Every item below was read out of the repository or the live database, with the
file and line checked. Where a claim was corrected by review, the corrected
version is what appears here.

### 7.1 The sequencing trap — read this before touching the enum

`rpc_clear_schema_drift` counts the stages it must see using
`enum_range(null::public.sample_stage)`, and the migration says so in its own
comment: *"Counted against the enum, so a new stage raises the bar without an
edit here."* It refuses a partial pass.

So the moment `dgm` joins the stage enum, **lifting a schema-drift latch
requires all eight tabs to verify clean.** If drift latches while the DGM tab
does not yet exist or its header does not match, the Sheets writer is fenced
for *every* stage — raw materials included — and the documented recovery path
cannot clear it.

Adding the enum value is also irreversible: Postgres has no `drop value`.

**Therefore: the workbook tab is authored and verified first, and the enum
value is added last.** That inverts the order one would naturally take.

### 7.2 Constraints that refuse an eighth stage outright

| Constraint | Where | Effect |
|---|---|---|
| `check (ordinal between 1 and 7)` | `0002_samples.sql:243` | Refuses ordinal 8. Must be dropped and re-added. |
| `check (prefix ~ '^[A-Z]{2}$')` | `0002_samples.sql:178` | **`DGM` cannot be the sample-ID prefix** — exactly two letters. `DG` is available. Your identifier scheme, so your call. |

### 7.3 The shape is flat, and that is enforced in four places

A sieve table cannot be stored as a nested structure. `apply_submitted_values`
accepts a flat JSON object of scalars and raises `BFF_BAD_VALUE` on anything
else, arrays included; `sample_measurements` is one row per `(sample, field)`;
`stage_fields` enforces `unique (stage, column_letter)`.

The seven sieves therefore **unroll horizontally** into distinct columns —
`sieve1_tare`, `sieve1_gross`, … — which is admissible (there is no pattern
check on `field_key`, so an indexed key is fine) and lands the row at roughly
40–60 columns. That is within limits; column letters round-trip past `Z`
correctly and both regexes allow up to `ZZ`.

Row width is asserted in **four** independent places, the last of which is
`rpc_enqueue_sheet_write` reading `stage_definitions.column_count` and raising
`BFF_ROW_TOO_WIDE`. A consequence worth stating plainly: **the number of
sieves is fixed by the stage schema, not by the payload.** A preset that
changes the sieve *count* is not expressible without a second stage.

### 7.4 Derived values have no honest home yet

This is the most interesting modelling problem in the feature.
`sample_measurements` has no column distinguishing a measured value from a
computed one, `recorded_by` defaults to the submitting user, and the
`numeric_keeps_precision` constraint requires `entered_text` — forcing a
fabricated "as typed" string for a number nobody typed.

Storing MF/DGM/DPG there as-is **files computed arithmetic as an operator's
attested measurement, inside the audit trail.** For a QMS that is the wrong
default. Options: a `source` column on `sample_measurements`, a separate
derived-results table, or compute-on-read. This needs a decision and is not a
detail.

Related: if every gross mass equals its tare, total retained mass is zero and
R% is 0/0. There is no "computed but undefined" state — the only way to say it
today is to write no row, which `sample_results_complete` then reads as an
incomplete test that blocks review.

### 7.5 Two consequences that are easy to miss

- **Do not give the derived outputs a `parameter_key`** until a limit is
  approved. `release_blockers` emits `not_assessable` as a *blocker*, so with
  0 of 34 limits approved, parameterising MF/DGM/DPG would make every DGM
  sample un-releasable except by explicit override.
- **The phone home screen holds exactly eight tiles** (seven stages + More).
  An eighth stage makes nine and breaks that grid. A confirmed layout break,
  not a styling preference.

### 7.6 Confirmed: no formula may reach the workbook

Writes use `valueInputOption=RAW`, and `encodeText` throws for any
non-freeform field whose text begins with `=`, `+`, `-` or `@`. Both halves of
the "compute it in the sheet" option are closed by design. Derived values are
computed server-side and written as numbers — which §3.1 already assumed, now
confirmed rather than asserted.

---

## 8. Open questions for the lab, not for the code

1. Is the stack a 400-mesh sieve plus a pan, or a pan alone? (§2.3)
2. Is the sample mass standardised? If DPG is kept as-is (§2.2), the number is
   only comparable between samples of equal mass.
3. Are RPM / Hz / position / grind time part of the quality record, or working
   notes? They are on the sheet; that does not settle whether they are
   controlled data.
4. Does DGM apply only to crumble, or to ground and pellets too? It decides
   whether this is one more stage or a test that can attach to several.
5. **Is DGM a stage at all?** You asked for an eighth tab, but the test is run
   *on* crumbled product. Modelled as a stage it mints its own sample IDs
   (`DG-YYMMDD-NN`) and is registered independently; modelled as a second test
   over an existing crumble sample it would reuse that sample's identity. The
   first is what this plan assumes and is much the simpler build; the second
   is arguably the truer description of what happens at the bench.
6. What identifies a DGM sample in the Samples list? The source sheet's
   identity fields are Date / Description / Hz / Pos / Time / RPM — there is no
   batch, lot or run number, and without one the list and search show a blank
   where every other stage shows a reference.
7. Do the Hz / position / time / RPM figures belong in the record as machine
   settings, or are they working notes? They are on the sheet; that does not
   settle whether they are controlled data.
