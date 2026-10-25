import { describe, it, expect } from 'vitest';
import {
  formatSampleId,
  parseSampleId,
  isValidSampleId,
  counterKey,
} from '@/lib/sampleId';

describe('sample ID format', () => {
  it('matches the example given in the workbook Read me tab', () => {
    expect(formatSampleId('RM', '2026-10-24', 1)).toBe('RM-261024-01');
  });

  it.each([
    ['RM', 1, 'RM-261024-01'],
    ['AM', 7, 'AM-261024-07'],
    ['BC', 12, 'BC-261024-12'],
    ['AC', 99, 'AC-261024-99'],
    ['AP', 1, 'AP-261024-01'],
    ['ES', 3, 'ES-261024-03'],
    ['CR', 42, 'CR-261024-42'],
    ['MS', 5, 'MS-261024-05'],
  ] as const)('%s #%i -> %s', (prefix, seq, expected) => {
    expect(formatSampleId(prefix, '2026-10-24', seq)).toBe(expected);
  });

  it('expands beyond 99 rather than wrapping or truncating', () => {
    expect(formatSampleId('RM', '2026-10-24', 100)).toBe('RM-261024-100');
    expect(formatSampleId('RM', '2026-10-24', 999)).toBe('RM-261024-999');
    expect(formatSampleId('RM', '2026-10-24', 1000)).toBe('RM-261024-1000');
  });

  it('rejects a non-positive or fractional sequence', () => {
    expect(() => formatSampleId('RM', '2026-10-24', 0)).toThrow(/positive/);
    expect(() => formatSampleId('RM', '2026-10-24', -1)).toThrow(/positive/);
    expect(() => formatSampleId('RM', '2026-10-24', 1.5)).toThrow(/positive/);
  });

  it('rejects an unknown prefix', () => {
    // @ts-expect-error deliberately invalid prefix
    expect(() => formatSampleId('ZZ', '2026-10-24', 1)).toThrow(/prefix/);
  });

  it('rejects a malformed date', () => {
    expect(() => formatSampleId('RM', '24/10/2026', 1)).toThrow();
  });
});

describe('sample ID parsing', () => {
  it('round-trips', () => {
    const id = formatSampleId('ES', '2026-01-05', 14);
    expect(id).toBe('ES-260105-14');
    expect(parseSampleId(id)).toEqual({ prefix: 'ES', datePart: '260105', sequence: 14 });
  });

  it('parses an expanded sequence', () => {
    expect(parseSampleId('RM-261024-1000')?.sequence).toBe(1000);
  });

  it.each([
    'RM-261024-1',        // single digit
    'ZZ-261024-01',       // unknown prefix
    'RM-26102-01',        // short date
    'RM261024-01',        // missing separator
    'rm-261024-01',       // lowercase
    'RM-261024-00',       // zero sequence
    '',
    'RM-261024-01 ',      // trailing space
  ])('rejects %s', (id) => {
    expect(parseSampleId(id)).toBeNull();
    expect(isValidSampleId(id)).toBe(false);
  });
});

describe('counter key', () => {
  it('is prefix plus plant-local collection date', () => {
    expect(counterKey('RM', '2026-10-24')).toBe('RM:2026-10-24');
  });

  it('separates AM from BC even though they share one tab', () => {
    // Both write to `2 Ground`, but each has its own daily sequence.
    expect(counterKey('AM', '2026-10-24')).not.toBe(counterKey('BC', '2026-10-24'));
  });

  it('separates consecutive days', () => {
    expect(counterKey('RM', '2026-10-24')).not.toBe(counterKey('RM', '2026-10-25'));
  });
});
