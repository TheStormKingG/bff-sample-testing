import { describe, it, expect } from 'vitest';
import {
  PLANT_TIME_ZONE,
  toPlantParts,
  fromPlantParts,
  plantLocalDate,
  idDatePart,
  plantOffsetMinutes,
  plantDayStart,
  plantDayEnd,
  formatPlantDateTimeLabelled,
} from '@/lib/time';

describe('plant time zone', () => {
  it('uses the IANA zone for Guyana', () => {
    expect(PLANT_TIME_ZONE).toBe('America/Guyana');
  });

  it('resolves the offset from the zone database, currently -240 minutes', () => {
    expect(plantOffsetMinutes(new Date('2026-10-24T12:00:00Z'))).toBe(-240);
    // No daylight saving: the offset is identical in January and July.
    expect(plantOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(-240);
    expect(plantOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(-240);
  });
});

describe('UTC instant -> plant-local parts', () => {
  it('converts a midday instant', () => {
    expect(toPlantParts(new Date('2026-10-24T16:30:00Z'))).toEqual({
      date: '2026-10-24',
      time: '12:30',
    });
  });

  it('keeps a late-evening sample on the plant-local day, not the UTC day', () => {
    // 21:00 in Guyana on 24 Oct is 01:00 UTC on 25 Oct. The operational log
    // and the ID sequence must both read 24 Oct.
    const instant = new Date('2026-10-25T01:00:00Z');
    expect(toPlantParts(instant)).toEqual({ date: '2026-10-24', time: '21:00' });
    expect(plantLocalDate(instant)).toBe('2026-10-24');
  });

  it('handles plant-local midnight without rolling the date (UAT boundary)', () => {
    const instant = new Date('2026-10-24T04:00:00Z'); // 00:00 Guyana
    expect(toPlantParts(instant)).toEqual({ date: '2026-10-24', time: '00:00' });
  });

  it('handles the last minute of a plant-local day', () => {
    const instant = new Date('2026-10-25T03:59:00Z'); // 23:59 Guyana 24 Oct
    expect(toPlantParts(instant)).toEqual({ date: '2026-10-24', time: '23:59' });
  });

  it('rejects an invalid instant rather than emitting NaN parts', () => {
    expect(() => toPlantParts(new Date('nonsense'))).toThrow(/invalid instant/i);
  });
});

describe('plant-local parts -> UTC instant', () => {
  it('round-trips a working-hours time', () => {
    expect(fromPlantParts('2026-10-24', '08:15').toISOString()).toBe('2026-10-24T12:15:00.000Z');
  });

  it('round-trips plant-local midnight', () => {
    expect(fromPlantParts('2026-10-24', '00:00').toISOString()).toBe('2026-10-24T04:00:00.000Z');
  });

  it('round-trips a late-evening time across the UTC date boundary', () => {
    expect(fromPlantParts('2026-10-24', '21:00').toISOString()).toBe('2026-10-25T01:00:00.000Z');
  });

  it('is the exact inverse of toPlantParts across a full day', () => {
    for (let hour = 0; hour < 24; hour++) {
      const time = `${String(hour).padStart(2, '0')}:30`;
      const instant = fromPlantParts('2026-10-24', time);
      expect(toPlantParts(instant)).toEqual({ date: '2026-10-24', time });
    }
  });

  it('accepts HH:mm:ss and ignores the seconds component', () => {
    expect(fromPlantParts('2026-10-24', '08:15:42').toISOString()).toBe('2026-10-24T12:15:00.000Z');
  });

  it('rejects malformed input instead of guessing', () => {
    expect(() => fromPlantParts('24-10-2026', '08:15')).toThrow(/YYYY-MM-DD/);
    expect(() => fromPlantParts('2026-10-24', '8:15')).toThrow(/HH:mm/);
    expect(() => fromPlantParts('2026-13-45', '08:15')).toThrow();
  });
});

describe('sample ID date component', () => {
  it('renders YYMMDD', () => {
    expect(idDatePart('2026-10-24')).toBe('261024');
  });

  it('matches the example in the workbook Read me tab', () => {
    // "RM-261024-01 is the first raw material sample on 24 October 2026"
    expect(`RM-${idDatePart('2026-10-24')}-01`).toBe('RM-261024-01');
  });

  it('zero-pads single-digit months and days', () => {
    expect(idDatePart('2026-01-05')).toBe('260105');
  });

  it('rejects a malformed date', () => {
    expect(() => idDatePart('2026/10/24')).toThrow();
  });
});

describe('plant-local day bounds for dashboard counts', () => {
  it('spans exactly 24 hours from local midnight', () => {
    const start = plantDayStart('2026-10-24');
    const end = plantDayEnd('2026-10-24');
    expect(start.toISOString()).toBe('2026-10-24T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-10-25T04:00:00.000Z');
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it('a 21:00 local sample falls inside its own local day', () => {
    const instant = new Date('2026-10-25T01:00:00Z');
    expect(instant >= plantDayStart('2026-10-24')).toBe(true);
    expect(instant < plantDayEnd('2026-10-24')).toBe(true);
    // ...and NOT inside the next local day, which a UTC-based count would claim
    expect(instant >= plantDayStart('2026-10-25')).toBe(false);
  });
});

describe('display labelling', () => {
  it('names the zone so a reader cannot assume their own locale', () => {
    expect(formatPlantDateTimeLabelled(new Date('2026-10-24T16:30:00Z')))
      .toBe('2026-10-24 12:30 (Guyana)');
  });
});
