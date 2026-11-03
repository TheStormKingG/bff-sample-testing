# Workbook restructure — `5 Extruded soya`

**Status: APPLIED 2026-11-02 and verified by read-back.** Written alongside
migration `0038_qualitative_urease.sql` and the registry change that turns the
urease test into a visual grade.

`scripts/check-workbook-headers.ts` reports all eight tabs matching the
registry with zero mismatches, `5 Extruded soya` at 15 columns. The change was
made with the spreadsheet's own **delete column** operation, which carried the
merges, fills, widths and number formats across intact: the `Test results`
band re-merged to `L3:M3` and `Follow-up` to `N3:O3` by itself, because N was
not the top-left cell of either.

## Why this document exists

`verifyWorkbook()` compares every `sheet_header` in `src/forms/registry.ts`
against row 4 of the live tab and **fails closed** on any mismatch. The
registry now declares fifteen columns on `5 Extruded soya` where the workbook
has sixteen, and column M is headed differently. Until the workbook is
restructured the sheet sync for this tab will refuse to write.

It refuses — it does not corrupt. Registration still succeeds, the event waits
in `sheet_sync_outbox`, and it drains once the headers match. But nothing
reaches the spreadsheet in the meantime.

## What changes

| Was | Becomes |
| --- | --- |
| **M** `Urease (pH rise)` — a number | **M** `Qualitative urease` — one of four assessments |
| **N** `Protein solubility (%)` | *deleted* |
| **O** `Tested by (QO)` | **N** |
| **P** `Comments` | **O** |

`A:P` (16 columns) → `A:O` (15 columns).

## What makes this safe to do

The tab holds **one data row**, at row 5 — `ES-261027-01`, a commissioning
record now marked `voided`. It carries values in A–L only: no urease figure
and no protein solubility were ever recorded on it, because nobody has
completed the testing phase on this tab.

Checked against the project before this was written, rather than assumed:

```sql
select stage, field_key, count(*) from sample_measurements
 where stage = 'extruded_soya'
   and field_key in ('urease_ph_rise', 'protein_solubility_pct')
 group by 1, 2;
-- 0 rows
```

The same query over `assessments` and `holds` also returns 0 rows, and
`dgm_log_column_map` has no entry sourced from this tab. All four tables carry
a composite foreign key on `(stage, field_key)`, so the migration's deletes
**fail** rather than cascade if any of that is ever untrue.

So deleting column N shifts O and P left over cells that are empty on the one
row that exists, and column M is re-headed above a cell that holds nothing.

## Why the urease column stops being a number

The quantitative method needs a phosphate buffer, a urea buffer, a 30-minute
water bath at 30 °C, a filtration and a pH meter, and reports the **pH rise**
between the two tubes. What the mill runs is the visual test: 0.2 g of meal
wetted with urea-phenol red, read by eye against four reference dishes.

There is no number in that procedure. A `number` column asks the operator to
invent one, and the figure they would most likely reach for is the reference
band printed on the card — which is what the *other* method would have
reported for a dish that looks like this, not what anybody measured here.
That would put a reading nobody took on a quality record.

So the stored value is the assessment, and the band is shown beside the
photograph as orientation only:

| Observation | Activity | Assessment | pH rise (approx.) |
| --- | --- | --- | --- |
| No visible red colour | Inactive | Over cooked | 0.00 |
| A few scattered red particles | Slightly active | Properly cooked | 0.05–0.10 |
| About 25% or more red particles | Moderately active | Properly cooked | 0.10–0.20 |
| About 50% or more red particles | Very active | Under cooked | above 0.20 |

Source: Table 1, *Visual examination of soybean meal treated with Urea-Phenol
Red solution*, supplied by Bounty Farm 2026-11-02.

The sheet cell receives the label, not the code, so column M will hold one of:

```
Over cooked (urease inactive)
Properly cooked (slightly active)
Properly cooked (moderately active)
Under cooked (very active)
```

### The photographs were matched by measurement, not by position

The four reference images arrived in the **reverse** of the order they belong
in. The share of each dish that is strongly red is 0.01%, 3.54%, 6.93% and
57.14% respectively — a strictly increasing sequence, agreeing with the
captions printed under the source figure. `scripts/measure-urease-dishes.py`
is what produced those figures and will refuse to emit an evidence block for
four dishes that are not in increasing order of redness.

## The order to do it in

1. **Restructure the workbook** to match the table below.
2. **Apply migration 0038** to the live project.
3. **Deploy the Edge Functions**, so the server knows the new column.
4. **Push the frontend**, so the browser offers it.

Between 3 and 4 a browser still holding the old bundle would send
`urease_ph_rise` and be told `unknown_field`; between 1 and 3 the sheet sync
for this tab stalls. Both are refusals with an error message, not silent loss,
and both clear on a reload once the deploy lands.

## The tab, afterwards

Row 3 bands, each a merged range:

- `A3:F3` — **Sample details**
- `G3:K3` — **Settings when sampled**
- `L3:M3` — **Test results**
- `N3:O3` — **Follow-up**

Rows 1 and 2 merge across `A1:O1` and `A2:O2`.

Row 4, one header per column:

```
A  Sample ID
B  Date
C  Time
D  Run no.
E  Raw soya lot no.
F  Sampled by
G  Crusher roller gap (mm)
H  Steam line (%)
I  Steam line temperature (°C)
J  Extruder temperature (°C)
K  Amount (ton/hr)
L  Moisture (%)
M  Qualitative urease
N  Tested by (QO)
O  Comments
```

Use the spreadsheet's own **delete column** operation on N rather than
clearing and retyping: it carries the merges, fills, widths and number formats
across intact. The one thing to watch, from the 0033 restructure, is that a
merged range keeps its value in its **top-left** cell — N is not the top-left
of any band here, so the row-3 labels survive, but the `Test results` band will
need re-merging from `L3:N3` down to `L3:M3`, and `Follow-up` from `O3:P3` to
`N3:O3`.

Column M only needs its **row-4 text** replaced. It stays a text column; no
number format applies to it any more.

## Afterwards

Read row 4 back out of the tab rather than looking at it:

```bash
BFF_SPREADSHEET_ID=... npx vite-node scripts/check-workbook-headers.ts
```

That read-back is not a formality. It is what caught `DGM (¬µm)` on the DGM
tab, where the clipboard carried UTF-8 bytes that Sheets decoded as Mac Roman.
There is no `µ` on this tab, but the `°C` in columns I and J is U+00B0 and is
the same hazard.

The `Read me` tab also describes what each tab tests. Its urease row should
stop describing a pH rise and describe the colour comparison, and its protein
solubility row should go.
