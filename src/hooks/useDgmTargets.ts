/**
 * The DGM target ranges, read from the APPROVED specifications.
 *
 * ===========================================================================
 * THIS USED TO BE AN ADMINISTRATOR SETTING, AND THAT WAS THE WRONG HOME
 * ===========================================================================
 * The 900-1200 µm band was stored in `system_config` and edited on an admin
 * screen, because when it was built a computed result could not be assessed
 * at all — `sample_derived_results` had no verdict column and the engine was
 * never called on that path, so the specification workflow had nowhere to
 * put an answer. The setting was the only way to get a band onto a chart.
 *
 * Migration 0041 removed that constraint. So the band now comes from the
 * same place every other limit does: a specification version that was
 * proposed by one person, approved by a different one, carries an effective
 * date and a mandatory source, and is versioned so an old record can be read
 * against the rule that was in force when it was made.
 *
 * The consequence is deliberate and was chosen with the plant: UNTIL
 * SOMEBODY APPROVES ONE, NO BAND IS DRAWN. A target that colours a quality
 * record with nobody's approval behind it is the thing this application
 * exists not to do.
 *
 * ===========================================================================
 * TWO RULES, NO BAND
 * ===========================================================================
 * The engine picks between competing rules by specificity — a rule pinned to
 * a material or a sampling point beats a general one — and refuses to choose
 * when two are equally applicable. A chart cannot reproduce that: it draws
 * one band for a whole stage before a sample's material is even known.
 *
 * So when a stage has more than one approved range this reports the
 * ambiguity and draws nothing, rather than picking the first row. The
 * measurement's own verdict is unaffected: the engine still decides it, per
 * sample, with the sample's context, and says `ambiguous_rules` if it cannot.
 *
 * ===========================================================================
 * THE BAND IS TODAY'S; THE VERDICT IS THE RECORD'S
 * ===========================================================================
 * This reads the ranges in force NOW, which is right for a form being filled
 * in. Opening a record made last year therefore shows today's band around
 * last year's figure. That is a real limitation and not a hidden one: the
 * stored verdict beside the figure cites the rule and version that actually
 * decided it, and that is the quality record. The band is orientation.
 */

import { useQuery, type UseQueryResult } from '@tanstack/react-query';

import { supabase } from '@/lib/supabase';
import { TABLES } from '@/hooks/useSamples';
import { STAGES, type Stage } from '@/forms/types';
import {
  emptyDgmTargets,
  type DgmTargetDocument,
  type DgmTargetRange,
} from '@/lib/dgmTargets';

/** The parameter a DGM band is a limit on, for every sieve stage. */
export const DGM_PARAMETER_SUFFIX = '.avg_particle_size';

/** Micrometres. An approved limit in any other unit is not this band. */
const DGM_UNIT = 'µm';

export interface DgmTargetState {
  readonly document: DgmTargetDocument;
  /** False when no approved range is in force on any stage. */
  readonly stored: boolean;
  /** Why an approved range was not used, when one existed but could not be. */
  readonly problem: string | null;
}

interface ApprovedRangeRow {
  readonly parameter_key: string;
  readonly stage: string;
  readonly unit: string | null;
  readonly lower_bound: number | null;
  readonly upper_bound: number | null;
  readonly approved_by: string | null;
  readonly effective_from: string;
  readonly effective_to: string | null;
  readonly source_evidence: string;
}

export function useDgmTargets(): UseQueryResult<DgmTargetState> {
  return useQuery<DgmTargetState>({
    queryKey: ['dgm-target-ranges'],
    // A limit changes when somebody approves a new version, not during a
    // shift. Invalidated outright when an approval is recorded.
    staleTime: 60 * 60 * 1000,
    retry: false,
    queryFn: async () => {
      const none = (problem: string | null): DgmTargetState => ({
        document: emptyDgmTargets(),
        stored: false,
        problem,
      });

      const { data, error } = await supabase
        .from(TABLES.specificationVersions)
        .select(
          'parameter_key,stage,unit,lower_bound,upper_bound,approved_by,effective_from,effective_to,source_evidence',
        )
        .eq('status', 'approved');

      if (error !== null) return none(null);

      const now = Date.now();
      const rows = ((data ?? []) as ApprovedRangeRow[]).filter(
        (r) =>
          r.parameter_key.endsWith(DGM_PARAMETER_SUFFIX) &&
          // The same four conditions the engine applies. An approved row
          // missing any of them decides nothing, so it must draw nothing.
          r.approved_by !== null &&
          r.unit === DGM_UNIT &&
          r.lower_bound !== null &&
          r.upper_bound !== null &&
          Date.parse(r.effective_from) <= now &&
          (r.effective_to === null || Date.parse(r.effective_to) > now),
      );

      const byStage = new Map<string, ApprovedRangeRow[]>();
      for (const row of rows) {
        const list = byStage.get(row.stage);
        if (list) list.push(row);
        else byStage.set(row.stage, [row]);
      }

      const ranges: Record<string, DgmTargetRange> = {};
      const ambiguous: string[] = [];
      for (const [stage, list] of byStage) {
        if (!(STAGES as readonly string[]).includes(stage)) continue;
        if (list.length > 1) {
          ambiguous.push(stage);
          continue;
        }
        const row = list[0]!;
        ranges[stage as Stage] = {
          lowerMicrons: Number(row.lower_bound),
          upperMicrons: Number(row.upper_bound),
          // The rule's own stated source, which the schema requires to be
          // non-empty — so a band on a quality record can always say where
          // its figures came from.
          basis: row.source_evidence,
        };
      }

      const document = { version: 1, ranges } as DgmTargetDocument;
      if (ambiguous.length > 0) {
        return {
          document,
          stored: Object.keys(ranges).length > 0,
          problem:
            `More than one approved average-particle-size limit applies to ${ambiguous.join(', ')}, ` +
            'so no band is drawn there. A chart cannot choose between two equally applicable ' +
            'limits the way the engine does, per sample. Supersede one of them.',
        };
      }

      return { document, stored: Object.keys(ranges).length > 0, problem: null };
    },
  });
}
