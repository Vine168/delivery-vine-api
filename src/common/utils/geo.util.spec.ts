import { describe, expect, it } from 'vitest';
import { GeoUtil } from './geo.util.js';

describe('GeoUtil', () => {
  const independenceMonument = { latitude: 11.5564, longitude: 104.9282 };
  const royalPalace = { latitude: 11.5637, longitude: 104.9316 };

  it('measures a known short distance in Phnom Penh', () => {
    const metres = GeoUtil.haversineMeters(independenceMonument, royalPalace);
    expect(metres).toBeGreaterThan(800);
    expect(metres).toBeLessThan(950);
  });

  it('returns zero for the same point', () => {
    expect(GeoUtil.haversineMeters(independenceMonument, independenceMonument)).toBe(0);
  });

  it('is symmetric', () => {
    expect(GeoUtil.haversineMeters(independenceMonument, royalPalace)).toBe(
      GeoUtil.haversineMeters(royalPalace, independenceMonument),
    );
  });

  it('rejects impossible coordinates', () => {
    expect(GeoUtil.isValidCoordinates({ latitude: 91, longitude: 0 })).toBe(false);
    expect(GeoUtil.isValidCoordinates({ latitude: 0, longitude: 181 })).toBe(false);
    expect(GeoUtil.isValidCoordinates({ latitude: Number.NaN, longitude: 0 })).toBe(false);
    expect(GeoUtil.isValidCoordinates(independenceMonument)).toBe(true);
  });
});
