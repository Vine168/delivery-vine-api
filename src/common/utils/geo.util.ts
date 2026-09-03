export interface Coordinates {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_008.8;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export const GeoUtil = {
  isValidLatitude(value: number): boolean {
    return Number.isFinite(value) && value >= -90 && value <= 90;
  },

  isValidLongitude(value: number): boolean {
    return Number.isFinite(value) && value >= -180 && value <= 180;
  },

  isValidCoordinates(point: Coordinates): boolean {
    return GeoUtil.isValidLatitude(point.latitude) && GeoUtil.isValidLongitude(point.longitude);
  },

  /**
   * Great-circle distance in metres. Used for eligibility filtering and as the
   * fallback when the routing provider is unavailable — never as the billed
   * distance when a real route is obtainable.
   */
  haversineMeters(from: Coordinates, to: Coordinates): number {
    const dLat = toRadians(to.latitude - from.latitude);
    const dLon = toRadians(to.longitude - from.longitude);
    const lat1 = toRadians(from.latitude);
    const lat2 = toRadians(to.latitude);

    const a =
      Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
    return Math.round(2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(a)));
  },

  /** Rounds coordinates for cache keys — ~11 m at 4 decimal places. */
  cacheKeyFor(point: Coordinates, precision = 4): string {
    return `${point.latitude.toFixed(precision)}:${point.longitude.toFixed(precision)}`;
  },
};
