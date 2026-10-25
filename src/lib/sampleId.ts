/**
 * Human-readable sample identifiers: `PREFIX-YYMMDD-NN`.
 *
 * Confirmed verbatim by the workbook `Read me` tab: "RM raw material, AM after
 * the mill, BC before conditioning, AC after conditioning, AP after pelleting,
 * ES extruded soya, CR crumble, MS mash. Example: RM-261024-01 is the first
 * raw material sample on 24 October 2026."
 *
 * This module only FORMATS and PARSES. Allocation is not here and must not be:
 * the sequence is issued by an atomic Postgres transaction against
 * `sample_id_counters` (migration 0002). Master Prompt §5 forbids computing a
 * sequence by COUNTIF, by scanning the last sheet row, or by any frontend
 * counter — all three are read-then-write races that mint duplicate IDs under
 * concurrency.
 */

import { ALL_PREFIXES, type SamplePrefix } from '../forms/registry.ts';
import { idDatePart } from './time.ts';

/** Minimum digits in the sequence component; widens automatically past 99. */
export const MIN_SEQUENCE_DIGITS = 2;

const ID_PATTERN = new RegExp(`^(${ALL_PREFIXES.join('|')})-(\\d{6})-(\\d{${MIN_SEQUENCE_DIGITS},})$`);

export interface ParsedSampleId {
  readonly prefix: SamplePrefix;
  /** `YYMMDD` as it appears in the identifier. */
  readonly datePart: string;
  readonly sequence: number;
}

/**
 * Build an identifier from a prefix, a PLANT-LOCAL collection date and an
 * allocated sequence number.
 */
export function formatSampleId(
  prefix: SamplePrefix,
  plantLocalDate: string,
  sequence: number,
): string {
  if (!ALL_PREFIXES.includes(prefix)) {
    throw new Error(`Unknown sample prefix ${JSON.stringify(prefix)}`);
  }
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Sample sequence must be a positive integer, received ${sequence}`);
  }
  // Pads to two digits, then grows naturally: 99 -> "99", 100 -> "100".
  const seq = String(sequence).padStart(MIN_SEQUENCE_DIGITS, '0');
  return `${prefix}-${idDatePart(plantLocalDate)}-${seq}`;
}

/** Parse an identifier, or return null if it is not well formed. */
export function parseSampleId(id: string): ParsedSampleId | null {
  const match = ID_PATTERN.exec(id);
  if (!match) return null;
  const sequence = Number(match[3]);
  if (!Number.isInteger(sequence) || sequence < 1) return null;
  return {
    prefix: match[1] as SamplePrefix,
    datePart: match[2]!,
    sequence,
  };
}

export function isValidSampleId(id: string): boolean {
  return parseSampleId(id) !== null;
}

/**
 * The counter key an allocation contends on. Master Prompt §5: the sequence
 * key is `prefix + collection_date`, so AM and BC count independently even
 * though they share a tab, and two different stages never share a counter.
 */
export function counterKey(prefix: SamplePrefix, plantLocalDate: string): string {
  return `${prefix}:${plantLocalDate}`;
}
