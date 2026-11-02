# Workbook restructure — `2 Ground`, `6 Crumble`, `7 Mash`

**Status: NOT YET APPLIED to the live workbook.** Written 2026-11-02, alongside
migration `0029_sieve_test_on_three_stages.sql` and the registry change that
puts the sieve test on these three tabs.

## Why this document exists

`verifyWorkbook()` compares every `sheet_header` in `src/forms/registry.ts`
against row 4 of the live tab and FAILS CLOSED on any mismatch. The registry
now declares forty columns on `2 Ground` where the workbook has fifteen, so
until the workbook is restructured the sheet sync for these three tabs will
refuse to write. It refuses — it does not corrupt: registration still
succeeds, the event waits in `sheet_sync_outbox`, and it drains once the
headers match. But nothing reaches the spreadsheet in the meantime.

## What makes this safe to do

All three tabs hold **zero data rows**. Confirmed 2026-11-02 by reading
`A5:F12` on each: every one came back empty. Only `8 DGM` has records (four).
So no cell moves, nothing shifts under a value, and the only thing being
rewritten is the header block in rows 1–4.

The two columns being removed — `Average particle size (µm)` and `Size spread
(GSD)` — hold no values either, in the workbook or in the database: a query
over `sample_measurements` for those keys on these three stages returned no
rows. See the header of migration 0029 for why that was inevitable rather
than lucky.

## The order to do it in

1. **Restructure the workbook** to match the tables below.
2. **Apply migration 0029** to the live project.
3. **Deploy the Edge Functions**, so the server knows the new columns.
4. **Push the frontend**, so the browser offers them.

Between 3 and 4 a browser still holding the old bundle will send
`avg_particle_size_um` and be told `unknown_field`; between 1 and 3 the sheet
sync for these tabs stalls. Both are refusals with an error message, not
silent loss, and both clear on a reload once the deploy lands. It is still
worth picking a quiet few minutes.

## Afterwards

Read row 4 back out of each tab and compare it against
`VERIFIED_HEADERS` in `tests/registry.test.ts`, the same way `8 DGM` was
checked when it was authored. That read-back is not a formality: it is what
caught `DGM (¬µm)` on the DGM tab, where the clipboard carried UTF-8 bytes
that Sheets decoded as Mac Roman. **Every `µ` below is U+00B5.**

The `Read me` tab also describes what each tab tests, and three of its rows
still say "average particle size and size spread". They should read as a
sieve test.

---

### `2 Ground` — A:AN (40 columns)

Row 3 bands, each a merged range:

- `A3:G3` — **Sample details**
- `H3:M3` — **Settings when sampled**
- `N3:AK3` — **Test results**
- `AL3:AN3` — **Follow-up**

Rows 1 and 2 merge across `A1:AN1` and `A2:AN2`.

Row 4, one header per column:

```
A	Sample ID
B	Date
C	Time
D	Sampling point
E	Material or feed type
F	Batch or bin no.
G	Sampled by
H	Mill screen size (mm)
I	Hammer distance from screen (mm)
J	Durability tester RPM
K	Sieve shaker frequency (Hz)
L	Vibration time (min)
M	Sieve series
N	Moisture (%) at BC
O	ABNT 5 empty sieve (g)
P	ABNT 5 sieve + sample (g)
Q	ABNT 10 empty sieve (g)
R	ABNT 10 sieve + sample (g)
S	ABNT 16 empty sieve (g)
T	ABNT 16 sieve + sample (g)
U	ABNT 30 empty sieve (g)
V	ABNT 30 sieve + sample (g)
W	ABNT 50 empty sieve (g)
X	ABNT 50 sieve + sample (g)
Y	ABNT 400 empty sieve (g)
Z	ABNT 400 sieve + sample (g)
AA	Pan empty (g)
AB	Pan + sample (g)
AC	Total retained (g)
AD	Fineness module (MF)
AE	DGM (µm)
AF	UI coarse (%)
AG	UI average (%)
AH	UI fine (%)
AI	DPG legacy index
AJ	Geometric standard deviation
AK	GSD basis
AL	Action taken
AM	Tested by (QO)
AN	Comments
```

As one tab-separated line, to paste into `A4`:

```
Sample ID	Date	Time	Sampling point	Material or feed type	Batch or bin no.	Sampled by	Mill screen size (mm)	Hammer distance from screen (mm)	Durability tester RPM	Sieve shaker frequency (Hz)	Vibration time (min)	Sieve series	Moisture (%) at BC	ABNT 5 empty sieve (g)	ABNT 5 sieve + sample (g)	ABNT 10 empty sieve (g)	ABNT 10 sieve + sample (g)	ABNT 16 empty sieve (g)	ABNT 16 sieve + sample (g)	ABNT 30 empty sieve (g)	ABNT 30 sieve + sample (g)	ABNT 50 empty sieve (g)	ABNT 50 sieve + sample (g)	ABNT 400 empty sieve (g)	ABNT 400 sieve + sample (g)	Pan empty (g)	Pan + sample (g)	Total retained (g)	Fineness module (MF)	DGM (µm)	UI coarse (%)	UI average (%)	UI fine (%)	DPG legacy index	Geometric standard deviation	GSD basis	Action taken	Tested by (QO)	Comments
```

### `6 Crumble` — A:AM (39 columns)

Row 3 bands, each a merged range:

- `A3:F3` — **Sample details**
- `G3:K3` — **Settings when sampled**
- `L3:AK3` — **Test results**
- `AL3:AM3` — **Follow-up**

Rows 1 and 2 merge across `A1:AM1` and `A2:AM2`.

Row 4, one header per column:

```
A	Sample ID
B	Date
C	Time
D	Feed type
E	Batch no.
F	Sampled by
G	Crumbler roll gap (mm)
H	Durability tester RPM
I	Sieve shaker frequency (Hz)
J	Vibration time (min)
K	Sieve series
L	Moisture (%)
M	Pellet durability (PDI, %)
N	Crumble size (mm)
O	ABNT 5 empty sieve (g)
P	ABNT 5 sieve + sample (g)
Q	ABNT 10 empty sieve (g)
R	ABNT 10 sieve + sample (g)
S	ABNT 16 empty sieve (g)
T	ABNT 16 sieve + sample (g)
U	ABNT 30 empty sieve (g)
V	ABNT 30 sieve + sample (g)
W	ABNT 50 empty sieve (g)
X	ABNT 50 sieve + sample (g)
Y	ABNT 400 empty sieve (g)
Z	ABNT 400 sieve + sample (g)
AA	Pan empty (g)
AB	Pan + sample (g)
AC	Total retained (g)
AD	Fineness module (MF)
AE	DGM (µm)
AF	UI coarse (%)
AG	UI average (%)
AH	UI fine (%)
AI	DPG legacy index
AJ	Geometric standard deviation
AK	GSD basis
AL	Tested by (QO)
AM	Comments
```

As one tab-separated line, to paste into `A4`:

```
Sample ID	Date	Time	Feed type	Batch no.	Sampled by	Crumbler roll gap (mm)	Durability tester RPM	Sieve shaker frequency (Hz)	Vibration time (min)	Sieve series	Moisture (%)	Pellet durability (PDI, %)	Crumble size (mm)	ABNT 5 empty sieve (g)	ABNT 5 sieve + sample (g)	ABNT 10 empty sieve (g)	ABNT 10 sieve + sample (g)	ABNT 16 empty sieve (g)	ABNT 16 sieve + sample (g)	ABNT 30 empty sieve (g)	ABNT 30 sieve + sample (g)	ABNT 50 empty sieve (g)	ABNT 50 sieve + sample (g)	ABNT 400 empty sieve (g)	ABNT 400 sieve + sample (g)	Pan empty (g)	Pan + sample (g)	Total retained (g)	Fineness module (MF)	DGM (µm)	UI coarse (%)	UI average (%)	UI fine (%)	DPG legacy index	Geometric standard deviation	GSD basis	Tested by (QO)	Comments
```

### `7 Mash` — A:AJ (36 columns)

Row 3 bands, each a merged range:

- `A3:F3` — **Sample details**
- `G3:J3` — **Settings when sampled**
- `K3:AH3` — **Test results**
- `AI3:AJ3` — **Follow-up**

Rows 1 and 2 merge across `A1:AJ1` and `A2:AJ2`.

Row 4, one header per column:

```
A	Sample ID
B	Date
C	Time
D	Feed type
E	Batch no.
F	Sampled by
G	Durability tester RPM
H	Sieve shaker frequency (Hz)
I	Vibration time (min)
J	Sieve series
K	Moisture (%)
L	ABNT 5 empty sieve (g)
M	ABNT 5 sieve + sample (g)
N	ABNT 10 empty sieve (g)
O	ABNT 10 sieve + sample (g)
P	ABNT 16 empty sieve (g)
Q	ABNT 16 sieve + sample (g)
R	ABNT 30 empty sieve (g)
S	ABNT 30 sieve + sample (g)
T	ABNT 50 empty sieve (g)
U	ABNT 50 sieve + sample (g)
V	ABNT 400 empty sieve (g)
W	ABNT 400 sieve + sample (g)
X	Pan empty (g)
Y	Pan + sample (g)
Z	Total retained (g)
AA	Fineness module (MF)
AB	DGM (µm)
AC	UI coarse (%)
AD	UI average (%)
AE	UI fine (%)
AF	DPG legacy index
AG	Geometric standard deviation
AH	GSD basis
AI	Tested by (QO)
AJ	Comments
```

As one tab-separated line, to paste into `A4`:

```
Sample ID	Date	Time	Feed type	Batch no.	Sampled by	Durability tester RPM	Sieve shaker frequency (Hz)	Vibration time (min)	Sieve series	Moisture (%)	ABNT 5 empty sieve (g)	ABNT 5 sieve + sample (g)	ABNT 10 empty sieve (g)	ABNT 10 sieve + sample (g)	ABNT 16 empty sieve (g)	ABNT 16 sieve + sample (g)	ABNT 30 empty sieve (g)	ABNT 30 sieve + sample (g)	ABNT 50 empty sieve (g)	ABNT 50 sieve + sample (g)	ABNT 400 empty sieve (g)	ABNT 400 sieve + sample (g)	Pan empty (g)	Pan + sample (g)	Total retained (g)	Fineness module (MF)	DGM (µm)	UI coarse (%)	UI average (%)	UI fine (%)	DPG legacy index	Geometric standard deviation	GSD basis	Tested by (QO)	Comments
```
