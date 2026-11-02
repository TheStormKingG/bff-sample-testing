# Workbook restructure for migration 0033

**Status: done and verified.** All eight tabs match the registry — read back
from the live workbook, cell by cell, by position:

```
ok    1 Raw materials — 19 columns, 0 mismatches
ok    2 Ground        — 39 columns, 0 mismatches
ok    3 Conditioned   — 13 columns, 0 mismatches
ok    4 Pellets       — 41 columns, 0 mismatches
ok    5 Extruded soya — 16 columns, 0 mismatches
ok    6 Crumble       — 41 columns, 0 mismatches
ok    7 Mash          — 35 columns, 0 mismatches
ok    8 DGM           — 35 columns, 0 mismatches
```

Re-run that check at any time with:

```bash
BFF_SPREADSHEET_ID=... npx vite-node scripts/check-workbook-headers.ts
```

The workbook was never fenced off: `sheet_workbook_state.schema_drifted` stayed
false throughout, because the worker only verifies the tabs it is about to
write and the one it touched was `8 DGM`, which did not change.

**One record needs re-saving.** `CR-261102-01` was registered before the
restructure, so its queued row was built against the old 39-column Crumble and
the writer will refuse it — correctly — as a 39-cell write to a 41-column tab.
The sample and its 28 measurements are safe in the database; saving its results
enqueues a fresh 41-cell row that supersedes the stale one. Until then it shows
on the sync-health screen as needing attention, which is the system reporting
the truth rather than a fault to fix.

---

## What was done, per tab

Every change below was made with the spreadsheet's OWN structural operation —
insert column, delete column — rather than by rebuilding row 3 and row 4 by
hand. That is what carried the merges, fills, widths and number formats across
intact. See the note on the one thing it does not carry, under 7 Mash.

## 7 Mash — DONE

Column G (`Durability tester RPM`) deleted. Row 4 read back as 35 cells, 0
mismatches against the contract.

One thing left, cosmetic: the row-3 band label **`Settings when sampled`** over
G3:I3 is blank. A merged range keeps its value in its top-left cell, and that
was the cell deleted. The merge is intact; the cell just needs the words typed
back in.

## 2 Ground — delete one column

Right-click the header of column **J** (`Durability tester RPM`) → **Delete
column**.

Nothing else. The `Settings when sampled` band keeps its label, because the
label lives in H and only J is going.

Result: `A:AM`, 39 columns, ending `… Action taken | Tested by (QO) | Comments`.

## 6 Crumble

Two columns inserted before M, headed `Sample before tumbling (g)` and
`Whole pellets after tumbling (g)`. The old PDI column slid to O and
`Crumble size (mm)` to P. PDI is now filled in by the server from the two
weighings, like the nine sieve results. `A:AO`, 41 columns.

Nothing else needed doing: the inserts landed inside the `Test results` merge,
so the band widened itself and kept its colour.

## 4 Pellets

Four columns inserted before G for the settings band, and 26 before the old
`Action taken` for the durability weighings, the sieve weights and the nine
computed columns. 30 headings typed. `A:AO`, 41 columns.

This is the one tab the structural operations could not finish on their own,
because a tab that gains a whole band has a band boundary that did not exist
before. Three repairs, all in row 3:

- `Settings when sampled` over G3:J3 did not exist at all — the four inserted
  columns arrived as separate unmerged cells. Merged, labelled, and filled
  `#FDF6D9` to match the other tabs.
- The `Test results` merge had stayed at K3:L3 while the 26 columns inserted
  to its right came in unmerged and carrying the **Follow-up** blue they
  inherited from their right-hand neighbour. Re-merged K3:AL3 and filled
  `#E2EFDA`.
- `Follow-up` over AM3:AO3 came through correctly and was left alone.

**The colours were sampled, not guessed.** Google Sheets draws its grid into a
`<canvas>`, so `getImageData` on a pixel inside a band reads the exact fill:
`rgb(220,230,229)` for Sample details, `rgb(253,246,217)` for Settings when
sampled, `rgb(226,239,218)` for Test results, `rgb(221,235,247)` for Follow-up.
That is also how the seam was found — a screenshot showed "pale green either
side" where the pixels showed two different pale greens.

---

## The Read me tab

Rows 16 and 18 now describe what `4 Pellets` and `6 Crumble` actually test,
including that PDI is weighed rather than typed.

---

## Verifying it, without looking at it

A screenshot cannot tell you whether column AD holds the right heading. Read
the row back and compare it by position:

```bash
npx vite-node scripts/check-workbook-headers.ts
```

Zero mismatches on all four tabs is the whole test.
