import {
  DEFAULT_SIEVE_PRESET,
  computeDgm,
  sievePresetById,
  type SieveReading,
} from '@/lib/dgm';

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
 * NOTHING HERE IS A VERDICT. No limit on the workbook's `Limits` tab is
 * approved, so there is no band to shade, no target line to draw and no colour
 * that may mean good or bad. The accent is the project's informational blue,
 * never red, amber or green, and the title reports WHERE the mass sat, never
 * whether that is acceptable. A chart is the easiest place in an application
 * to imply an assessment nobody made.
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
const HEIGHT = 250;
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
}: ParticleSizeChartProps): JSX.Element | null {
  const preset = sievePresetById(values['sieve_series'] ?? '') ?? DEFAULT_SIEVE_PRESET;

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
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (plotW * i) / Math.max(1, points.length - 1);
  const y = (percent: number) => PAD.top + plotH - (plotH * percent) / ceiling;

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
      </p>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="mt-3 h-auto w-full max-w-lg"
        role="img"
        aria-labelledby="psd-heading psd-desc"
      >
        <desc id="psd-desc">
          {points
            .map(
              (p) =>
                `${p.position.isPan ? 'Pan' : `${p.position.apertureMicrons} micrometres`}: ${p.percent.toFixed(1)} per cent`,
            )
            .join('. ')}
        </desc>

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
          className="fill-blue-800 text-[14px] font-semibold tabular"
        >
          {peak.percent.toFixed(1)}%
        </text>

        {points.map((p, i) => (
          <text
            key={p.position.abnt}
            x={x(i)}
            y={HEIGHT - PAD.bottom + 18}
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
