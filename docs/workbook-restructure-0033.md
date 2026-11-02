# Workbook restructure for migration 0033

**Status: one tab of four done.** `7 Mash` is finished and verified. `2 Ground`,
`4 Pellets` and `6 Crumble` still carry their old row-4 headings.

**Until all four are done, the workbook will fence itself off.** That is the
designed behaviour, not a fault: `verifyWorkbook()` compares row 4 against the
registry character for character before any write, and a tab whose columns have
moved stops the writer rather than letting it put a moisture reading in the
protein column. One pending record is affected — `CR-261102-01` — and it is
safe in the database meanwhile.

To clear the latch once the tabs are done: **Admin → Workbook sync → verify
headers**, signed in as someone with `sync.retry`. A clean read lifts it.

---

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

## 6 Crumble — insert two columns and name them

1. Right-click the header of column **M** (`Pellet durability (PDI, %)`) →
   **Insert 2 columns to the left**.
2. Type into **M4**: `Sample before tumbling (g)`
3. Type into **N4**: `Whole pellets after tumbling (g)`

The old PDI column slides to O and `Crumble size (mm)` to P, which is where
both belong. PDI is now computed by the system from the two weighings, so its
column is filled in by the server like the nine sieve results.

Result: `A:AO`, 41 columns.

## 4 Pellets — the big one

This tab gains the whole sieve test and the durability test.

1. Right-click column **G** (`Pellet temperature (°C)`) → **Insert 4 columns to
   the left**, and type into G4..J4:

   | Cell | Heading |
   | --- | --- |
   | G4 | `Durability tester RPM` |
   | H4 | `Sieve shaker frequency (Hz)` |
   | I4 | `Vibration time (min)` |
   | J4 | `Sieve series` |

2. Right-click column **M** (now `Action taken`) → **Insert 26 columns to the
   left**, and fill M4..AL4 with, in order:

   `Sample before tumbling (g)`, `Whole pellets after tumbling (g)`,
   `Pellet durability (PDI, %)`,
   `ABNT 5 empty sieve (g)`, `ABNT 5 sieve + sample (g)`,
   `ABNT 10 empty sieve (g)`, `ABNT 10 sieve + sample (g)`,
   `ABNT 16 empty sieve (g)`, `ABNT 16 sieve + sample (g)`,
   `ABNT 30 empty sieve (g)`, `ABNT 30 sieve + sample (g)`,
   `ABNT 50 empty sieve (g)`, `ABNT 50 sieve + sample (g)`,
   `ABNT 400 empty sieve (g)`, `ABNT 400 sieve + sample (g)`,
   `Pan empty (g)`, `Pan + sample (g)`,
   `Total retained (g)`, `Fineness module (MF)`, `DGM (µm)`,
   `UI coarse (%)`, `UI average (%)`, `UI fine (%)`,
   `DPG legacy index`, `Geometric standard deviation`, `GSD basis`

   The micro sign in `DGM (µm)` is U+00B5 — the same character the other tabs
   use. Copying the cell from `8 DGM` is safer than retyping it; pasting it
   from somewhere else once arrived as `DGM (¬µm)`, because the clipboard
   carried UTF-8 that Sheets decoded as Mac Roman.

3. Row 3 bands, left to right: `Sample details` A:F, `Settings when sampled`
   G:J, `Test results` K:AL, `Follow-up` AM:AO.

Result: `A:AO`, 41 columns.

---

## Verifying it, without looking at it

A screenshot cannot tell you whether column AD holds the right heading. Read
the row back and compare it by position:

```bash
npx vite-node scripts/check-workbook-headers.ts
```

Zero mismatches on all four tabs is the whole test.
