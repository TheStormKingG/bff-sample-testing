/**
 * Plant-local time handling.
 *
 * PRD NFR-008 and §6.1: the server stores a full UTC instant, and separately
 * the local collection date and time that belong in the operational log. The
 * sample-ID sequence key is the plant-local COLLECTION date, never a server
 * UTC calendar date (Master Prompt §5), so a sample taken at 21:00 Guyana time
 * must not be filed under the following UTC day.
 *
 * The zone offset is resolved through the IANA database rather than hardcoded.
 * Guyana has been a fixed UTC-04:00 with no daylight saving since 1992, but
 * encoding "-04:00" as a literal would turn a future political change into
 * silently misdated quality records.
 */

export const PLANT_TIME_ZONE = 'America/Guyana';

export interface PlantDateTimeParts {
  /** `YYYY-MM-DD` in plant-local time. */
  readonly date: string;
  /** `HH:mm` in plant-local time, 24-hour. */
  readonly time: string;
}

const PART_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLANT_TIME_ZONE,
  hour12: false,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface NumericParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function numericParts(instant: Date, formatter: Intl.DateTimeFormat): NumericParts {
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  // Some ICU builds render midnight as hour 24 with hour12:false.
  const hour = Number(map['hour']) % 24;
  return {
    year: Number(map['year']),
    month: Number(map['month']),
    day: Number(map['day']),
    hour,
    minute: Number(map['minute']),
    second: Number(map['second']),
  };
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Minutes that plant-local time is ahead of UTC at the given instant. */
export function plantOffsetMinutes(instant: Date): number {
  const p = numericParts(instant, PART_FORMATTER);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // Millisecond component is identical in both representations.
  return Math.round((asIfUtc - (instant.getTime() - instant.getMilliseconds())) / 60_000);
}

/** Split a UTC instant into the plant-local date and time to be logged. */
export function toPlantParts(instant: Date): PlantDateTimeParts {
  assertValidInstant(instant);
  const p = numericParts(instant, PART_FORMATTER);
  return {
    date: `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
  };
}

/** The plant-local calendar date of an instant. The ID sequence key. */
export function plantLocalDate(instant: Date): string {
  return toPlantParts(instant).date;
}

/**
 * Convert a plant-local wall-clock date and time into a UTC instant.
 *
 * Resolved in two passes: a provisional instant gives the offset in force at
 * roughly that moment, which then corrects the instant. One correction is
 * sufficient for a fixed-offset zone and for every non-pathological DST
 * transition, which matters only if Guyana ever adopts one.
 */
export function fromPlantParts(localDate: string, localTime: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error(`Invalid plant-local date ${JSON.stringify(localDate)}: expected YYYY-MM-DD`);
  }
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(localTime)) {
    throw new Error(`Invalid plant-local time ${JSON.stringify(localTime)}: expected HH:mm`);
  }

  const provisional = new Date(`${localDate}T${localTime.slice(0, 5)}:00Z`);
  if (Number.isNaN(provisional.getTime())) {
    throw new Error(`Invalid plant-local date/time ${localDate} ${localTime}`);
  }
  const offset = plantOffsetMinutes(provisional);
  const corrected = new Date(provisional.getTime() - offset * 60_000);
  // Verify the round trip; a mismatch means a skipped wall-clock hour.
  const check = toPlantParts(corrected);
  if (check.date !== localDate || check.time !== localTime.slice(0, 5)) {
    const secondOffset = plantOffsetMinutes(corrected);
    return new Date(provisional.getTime() - secondOffset * 60_000);
  }
  return corrected;
}

/** `YYMMDD` component of a human sample ID, from a plant-local date. */
export function idDatePart(localDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error(`Invalid plant-local date ${JSON.stringify(localDate)}: expected YYYY-MM-DD`);
  }
  return localDate.slice(2).replace(/-/g, '');
}

/** Display an instant in plant-local time, for screens and reports. */
export function formatPlantDateTime(instant: Date): string {
  const { date, time } = toPlantParts(instant);
  return `${date} ${time}`;
}

/**
 * Label an instant unambiguously where a reader might otherwise assume their
 * own device locale (PRD §6.1: never rely exclusively on device locale).
 */
export function formatPlantDateTimeLabelled(instant: Date): string {
  return `${formatPlantDateTime(instant)} (Guyana)`;
}

function assertValidInstant(instant: Date): void {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) {
    throw new Error('Invalid instant');
  }
}

/** Start of a plant-local day as a UTC instant. For "samples today" queries. */
export function plantDayStart(localDate: string): Date {
  return fromPlantParts(localDate, '00:00');
}

/** Exclusive end of a plant-local day as a UTC instant. */
export function plantDayEnd(localDate: string): Date {
  const start = plantDayStart(localDate);
  return new Date(start.getTime() + 24 * 60 * 60_000);
}
