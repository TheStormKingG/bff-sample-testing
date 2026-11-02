import {
  DEFAULT_SIEVE_PRESET,
  computeDgm,
  sievePresetById,
  type SieveReading,
} from '@/lib/dgm';
import { applySieveSeries, type SieveSeriesDocument } from '@/lib/sieveSeries';
import {
  apertureIndex,
  dgmStanding,
  DGM_STANDING_LABELS,
  type DgmTargetRange,
} from '@/lib/dgmTargets';

/**
 * Where this sample's mass fell across the sieve stack.
 *
 * ===========================================================================
 * WHY IT IS DRAWN THE WAY IT IS
 * ===========================================================================
 * Built to Knaflic's "Storytelling with Data" discipline, which is mostly a
 * discipline of REMOVAL. The source workbook's chart carries a grey plot area,
 * a full border, horizontal gridlines every 5%, a legend naming one series, a
 * chart title that says "Distribution Chart" and axis titles in a second
 * language. None of that is information. Every one of them is ink the reader
 * has to look past to reach seven numbers, and the grey fill in particular
 * actively fights the data by lowering its contrast.
 *
 * So: no plot fill, no border, no legend, no gridlines. The axis is one hairline
 * where zero is. Everything contextual is grey; ONE colour appears in the whole
 * figure and it is on the line itself, which is therefore the first thing the
 * eye lands on — that is the entire purpose of spending the only colour there.
 *
 * THE TITLE STATES THE FINDING, not the chart type. "Distribution Chart" tells
 * a reader nothing they cannot see; "Most of this sample stayed on the 1200 µm
 * sieve" is the sentence they would write down. The modal bin is also labelled
 * on the plot itself rather than left to be read off an axis, because that
 * number is why the chart is here.
 *
 * THERE IS ONE BAND, AND IT IS THE ONLY THING ON THIS CHART THAT CAME FROM A
 * DECISION RATHER THAN FROM THE WEIGHINGS. This comment said, for as long as
 * there was no target: "no band to shade, no target line to draw and no
 * colour that may mean good or bad." That held while every limit in the
 * workbook was unapproved. A DGM target has since been set — stored,
 * administrator-written and audited, see `src/lib/dgmTargets.ts` — so the
 * band is drawn, and these are the limits on it:
 *
 *   IT IS DRAWN ONLY WHEN A TARGET IS PASSED IN. A form with no stored range
 *   renders exactly the chart it rendered before, with no green anywhere.
 *
 *   IT SAYS WHERE THE MEAN SHOULD SIT, NOT WHERE THE MASS SHOULD SIT, and the
 *   chart has to make that distinction or it lies. The curve is a
 *   distribution; the target is on its geometric mean. So the band is drawn
 *   WITH a marker at this sample's own DGM — the one figure the band is about
 *   — because a green region on a distribution with nothing in it to compare
 *   invites the reader to judge the curve against a limit that was never
 *   about the curve.
 *
 *   IT IS STILL NOT A VERDICT. Nothing here releases, rejects or holds. The
 *   sample's own mark stays the informational blue it has always been, even
 *   when it falls outside: a coarse grind is information for the miller, and
 *   turning the mark red would be a disposition nobody gave. Green marks the
 *   region that was aimed at; no colour anywhere means bad.
 *
 *   THE X AXIS IS A SIEVE STACK, NOT A RULER. Positions are evenly spaced on
 *   the plot but their apertures are roughly geometric, so a micrometre
 *   figure is placed by interpolating on the LOG of the apertures either side
 *   of it — see `apertureToX`. Interpolating linearly would put 1050 µm
 *   visibly off-centre between the 1200 and 600 sieves and quietly misreport
 *   where the band's edge is.
 *
 * ===========================================================================
 * WHY IT RECOMPUTES RATHER THAN BEING SENT THE PERCENTAGES
 * ===========================================================================
 * The nine derived columns do not include the per-sieve shares, and adding
 * seven more columns to the tab to carry them would be a schema change made
 * for a picture. `computeDgm` is imported instead — the SAME module the Edge
 * Function calls, so this is one implementation used twice and cannot drift
 * from the stored figures. It is the only thing in the browser that computes
 * anything about a sieve test, and it computes nothing that is stored.
 */
export interface ParticleSizeChartProps {
  /** The submitted form values, holding `sieveN_tare_g` / `sieveN_gross_g`. */
  readonly values: Readonly<Record<string, string>>;
  readonly className?: string;
  /**
   * The lab's own sieve table, when it has been edited. THE SAME table the
   * server computed the stored figures from — if the two diverged, this chart
   * would draw a different distribution from the one the record holds.
   */
  readonly series?: SieveSeriesDocument | null;
  /**
   * The DGM range this form is aiming at, when an administrator has set one.
   * `null` — the default, and the state of a form with no stored target —
   * draws no band at all.
   */
  readonly target?: DgmTargetRange | null;
}

/*
 * Sized for a PHONE, which is where this is read.
 *
 * An SVG scales to its container, so the viewBox width sets how big the text
 * comes out: at 560 units in a ~330px column every label rendered at about
 * 7px, which is unreadable and was invisible in a desktop preview. 360 puts
 * the scale near 1:1 on a phone, and `max-w-lg` stops the whole figure being
 * blown up on a wide screen, where the same ratio would make the labels
 * comically large instead.
 */
const WIDTH = 360;
/**
 * The figure without a target band. A band adds `BAND_LANE` to the bottom for
 * the marker's own label, rather than squeezing it between the aperture
 * labels and the axis title, where it would collide with both. The plot area
 * itself is the same height either way, so adding a target does not redraw
 * the curve at a different scale.
 */
const BASE_HEIGHT = 250;
const BAND_LANE = 18;
const PAD = { top: 22, right: 16, bottom: 46, left: 34 };

function massAt(values: Readonly<Record<string, string>>, key: string): number | null {
  const raw = values[key];
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function ParticleSizeChart({
  values,
  className,
  series = null,
  target = null,
}: ParticleSizeChartProps): JSX.Element | null {
  const preset = applySieveSeries(
    sievePresetById(values['sieve_series'] ?? '') ?? DEFAULT_SIEVE_PRESET,
    series,
  );

  const readings: SieveReading[] = [];
  for (let n = 1; n <= preset.positions.length; n++) {
    const tare = massAt(values, `sieve${n}_tare_g`);
    const gross = massAt(values, `sieve${n}_gross_g`);
    // A chart of a partial weighing would be a chart of a different sample.
    if (tare === null || gross === null || gross < tare) return null;
    readings.push({ tareGrams: tare, grossGrams: gross });
  }

  let result;
  try {
    result = computeDgm(readings, preset);
  } catch {
    // The figures on the screen come from the server; this is decoration.
    // It must never be the reason a confirmation screen fails to render.
    return null;
  }
  if (result.status === 'no_mass_retained') return null;

  const points = preset.positions.map((position, i) => ({
    position,
    percent: result.perSieve[i]?.retainedPercent ?? 0,
  }));

  const peak = points.reduce((best, p) => (p.percent > best.percent ? p : best), points[0]!);
  // A rounded ceiling, so the axis reads 45 rather than 41.58 and the line is
  // not jammed against the top of the frame.
  const ceiling = Math.max(10, Math.ceil(Math.max(...points.map((p) => p.percent)) / 10) * 10);

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = BASE_HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (plotW * i) / Math.max(1, points.length - 1);
  const y = (percent: number) => PAD.top + plotH - (plotH * percent) / ceiling;

  /*
    The target band, and the one mark the band is about.

    DRAWN ONLY IF IT IS ON THE STACK. A target whose whole range lies above
    the coarsest sieve or below the pan has nowhere honest to go: clamping it
    would paint a sliver against the frame that reads as a band at the edge of
    the chart rather than as a band off the end of it. Nothing is drawn, and
    the sentence under the heading still states the range in words.
  */
  const apertures = preset.positions.map((p) => p.apertureMicrons);
  const coarsest = apertures[0]!;
  const finest = apertures[apertures.length - 1]!;
  const onStack =
    target !== null && target.lowerMicrons < coarsest && target.upperMicrons > finest;
  const bandLeft = onStack ? apertureIndex(apertures, target.upperMicrons) : null;
  const bandRight = onStack ? apertureIndex(apertures, target.lowerMicrons) : null;
  const band =
    bandLeft === null || bandRight === null
      ? null
      : { x1: x(bandLeft), x2: x(bandRight) };

  const sampleDgm = result.dgmMicrons;
  const dgmIndex =
    band === null || sampleDgm === null ? null : apertureIndex(apertures, sampleDgm);
  const dgmX = dgmIndex === null ? null : x(dgmIndex);
  const standing = target === null || sampleDgm === null ? null : dgmStanding(sampleDgm, target);

  const HEIGHT = BASE_HEIGHT + (band === null ? 0 : BAND_LANE);
  const labelRow = BASE_HEIGHT - PAD.bottom + 18;

  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.percent)}`).join(' ');
  const peakIndex = points.indexOf(peak);
  const peakLabel = peak.position.isPan ? 'the pan' : `the ${peak.position.apertureMicrons} µm sieve`;
  const headline = `Most of this sample stayed on ${peakLabel}`;

  return (
    <section className={className} aria-labelledby="psd-heading">
      {/* Left-aligned, and the sentence IS the title. */}
      <h3 id="psd-heading" className="text-base font-semibold text-slate-900">
        {headline}
      </h3>
      <p className="mt-0.5 text-sm text-slate-600">
        Percentage of the retained mass left on each sieve, coarsest first.
        {target !== null && standing !== null ? (
          <>
            {' '}
            The green band is the range this form is aiming at for the average particle
            size — {target.lowerMicrons} to {target.upperMicrons} µm — and the dashed mark is
            where this sample&rsquo;s average fell:{' '}
            <span className="font-semibold">{DGM_STANDING_LABELS[standing].toLowerCase()}</span>.
          </>
        ) : null}
      </p>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-3 h-auto w-full max-w-lg"
        role="img"
        aria-labelledby="psd-heading psd-desc"
      >
        <desc id="psd-desc">
          {[
            ...points.map(
              (p) =>
                `${p.position.isPan ? 'Pan' : `${p.position.apertureMicrons} micrometres`}: ${p.percent.toFixed(1)} per cent`,
            ),
            // The band and the mark are information, not decoration, so they
            // are described rather than left to the sighted reader alone.
            ...(target !== null && standing !== null && sampleDgm !== null
              ? [
                  `Target range ${target.lowerMicrons} to ${target.upperMicrons} micrometres`,
                  `This sample's average particle size ${Math.round(sampleDgm)} micrometres, ` +
                    DGM_STANDING_LABELS[standing].toLowerCase(),
                ]
              : []),
          ].join('. ')}
        </desc>

        {/*
          The target band, behind everything. A pale fill rather than two
          edge lines: the region is the point, and two more lines on a figure
          whose whole discipline is removal would compete with the curve.
        */}
        {band !== null ? (
          <rect
            x={Math.min(band.x1, band.x2)}
            y={PAD.top}
            width={Math.abs(band.x2 - band.x1)}
            height={plotH}
            className="fill-green-100"
          />
        ) : null}

        {/* Two reference values only — zero and the ceiling. Gridlines every
            5% would be eleven lines competing with one. */}
        {[0, ceiling].map((v) => (
          <g key={v}>
            <text
              x={PAD.left - 6}
              y={y(v) + 4}
              textAnchor="end"
              className="fill-slate-400 text-[11px]"
            >
              {v}%
            </text>
          </g>
        ))}
        {/* The baseline, hairline and grey: a frame around the data would be
            four lines where one is needed. */}
        <line
          x1={PAD.left}
          y1={y(0)}
          x2={WIDTH - PAD.right}
          y2={y(0)}
          className="stroke-slate-300"
          strokeWidth={1}
        />

        <path d={path} fill="none" className="stroke-blue-700" strokeWidth={2.5} strokeLinejoin="round" />

        {points.map((p, i) => (
          <circle
            key={p.position.abnt}
            cx={x(i)}
            cy={y(p.percent)}
            r={i === peakIndex ? 5 : 3.5}
            className={i === peakIndex ? 'fill-blue-700' : 'fill-white stroke-blue-700'}
            strokeWidth={2}
          />
        ))}

        {/* The one annotation. Directly labelled, so the reader never has to
            trace a point back to an axis to learn the number the chart is
            about. Nudged inboard at the edges so it cannot clip. */}
        <text
          x={Math.min(Math.max(x(peakIndex), PAD.left + 26), WIDTH - PAD.right - 26)}
          y={y(peak.percent) - 12}
          textAnchor="middle"
          /*
            A white halo, painted UNDER the glyphs. The modal bin and the
            sample's own mean are often the same part of the stack — a coarse
            grind peaks near its own mean — so this label and the dashed
            marker land on top of each other on exactly the samples the band
            was added for. Moving the label would be guesswork about which
            side is free; a halo keeps it legible over anything.
          */
          stroke="white"
          strokeWidth={3}
          paintOrder="stroke"
          className="fill-blue-800 text-[14px] font-semibold tabular"
        >
          {peak.percent.toFixed(1)}%
        </text>

        {/*
          This sample's own geometric mean, which is the figure the band is
          about. Dashed, so it cannot be mistaken for the data line, and
          BLUE rather than red or amber even when it falls outside the band:
          the mark says where the mean is, and the words say where that sits
          against the target. See the header — nothing here is a verdict.
        */}
        {dgmX !== null && sampleDgm !== null ? (
          <g>
            <line
              x1={dgmX}
              y1={PAD.top}
              x2={dgmX}
              y2={y(0)}
              className="stroke-blue-900"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
            <text
              x={Math.min(Math.max(dgmX, PAD.left + 30), WIDTH - PAD.right - 30)}
              y={labelRow + 18}
              textAnchor="middle"
              className="fill-blue-900 text-[11px] font-semibold tabular"
            >
              DGM {Math.round(sampleDgm)} µm
            </text>
          </g>
        ) : null}

        {points.map((p, i) => (
          <text
            key={p.position.abnt}
            x={x(i)}
            y={labelRow}
            textAnchor="middle"
            className={
              i === peakIndex
                ? 'fill-slate-900 text-[12px] font-semibold tabular'
                : 'fill-slate-500 text-[12px] tabular'
            }
          >
            {p.position.isPan ? 'Pan' : p.position.apertureMicrons}
          </text>
        ))}
        <text
          x={PAD.left + plotW / 2}
          y={HEIGHT - 6}
          textAnchor="middle"
          className="fill-slate-500 text-[11px]"
        >
          Sieve aperture (µm)
        </text>
      </svg>
    </section>
  );
}
