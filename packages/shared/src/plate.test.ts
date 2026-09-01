import { describe, expect, it } from 'vitest';
import { PlateNormalizationError, formatPlateForDisplay, normalizePlate } from './plate.js';

describe('normalizePlate', () => {
  it('collapses the separators people actually type', () => {
    const variants = ['M AB 1234', 'M-AB-1234', 'm ab1234', ' M·AB 1234 ', 'M.AB.1234'];
    const normalized = variants.map((v) => normalizePlate(v, 'DE').normalized);
    expect(new Set(normalized)).toEqual(new Set(['MAB1234']));
  });

  it('folds umlauts so a plate is found however it was typed', () => {
    expect(normalizePlate('LÖ AB 123', 'DE').normalized).toBe('LOAB123');
    expect(normalizePlate('LO AB 123', 'DE').normalized).toBe('LOAB123');
  });

  it('keeps the E and H suffixes, which are part of the plate', () => {
    expect(normalizePlate('M AB 123E', 'DE').normalized).toBe('MAB123E');
    expect(normalizePlate('B XY 42H', 'DE').normalized).toBe('BXY42H');
  });

  it('flags but does not reject plates outside the country format', () => {
    const result = normalizePlate('0 12 345', 'DE');
    expect(result.normalized).toBe('012345');
    expect(result.matchesCountryFormat).toBe(false);
  });

  it('accepts well-formed plates for each supported country', () => {
    expect(normalizePlate('W 12345A', 'AT').matchesCountryFormat).toBe(true);
    expect(normalizePlate('ZH 123456', 'CH').matchesCountryFormat).toBe(true);
    expect(normalizePlate('AB-123-CD', 'FR').matchesCountryFormat).toBe(true);
  });

  it('rejects input that cannot be a plate', () => {
    expect(() => normalizePlate('', 'DE')).toThrow(PlateNormalizationError);
    expect(() => normalizePlate('   ', 'DE')).toThrow(PlateNormalizationError);
    expect(() => normalizePlate('!!!', 'DE')).toThrow(/does not look like/);
    expect(() => normalizePlate('AB', 'DE')).toThrow(/at least/);
    expect(() => normalizePlate('ABCDEFGHIJKLMNOP', 'DE')).toThrow(/at most/);
  });

  it('is idempotent, so re-normalizing a stored value is safe', () => {
    const once = normalizePlate('M AB 1234', 'DE').normalized;
    expect(normalizePlate(once, 'DE').normalized).toBe(once);
  });
});

describe('formatPlateForDisplay', () => {
  it('renders German plates in the familiar grouping', () => {
    expect(formatPlateForDisplay('MAB1234', 'DE')).toBe('M-AB 1234');
    expect(formatPlateForDisplay('BXY42H', 'DE')).toBe('B-XY 42H');
  });

  it('falls back to the raw value when the pattern does not apply', () => {
    expect(formatPlateForDisplay('012345', 'DE')).toBe('012345');
  });
});
