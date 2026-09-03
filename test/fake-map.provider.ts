import type { Coordinates } from '../src/common/utils/geo.util.js';
import { GeoUtil } from '../src/common/utils/geo.util.js';
import type {
  MapProvider,
  MatrixResult,
  PlaceResult,
  RouteResult,
  RoutingProfile,
} from '../src/modules/locations/providers/map-provider.interface.js';

/**
 * A deterministic stand-in for the map service.
 *
 * e2e tests assert on prices, and a price depends on a distance — so the
 * distance has to be a fact of the test, not whatever the live routing engine
 * says today. Road distance is modelled as straight-line × 1.3, the same
 * assumption the real adapter falls back to.
 */
export class FakeMapProvider implements MapProvider {
  /** Set to make the next call fail, to exercise the fallback paths. */
  shouldFail = false;

  private readonly places: PlaceResult[] = [
    {
      placeId: 'W:311065501',
      name: 'Independence Monument',
      address: 'Independence Monument, Norodom Blvd, Phnom Penh',
      latitude: 11.5564,
      longitude: 104.9282,
      street: 'Norodom Blvd',
      district: 'Chamkarmon',
      city: 'Phnom Penh',
      state: 'Phnom Penh',
      postcode: '120102',
      countryCode: 'KH',
      category: 'attraction',
    },
    {
      placeId: 'W:687168292',
      name: 'AEON Mall 1',
      address: 'AEON Mall 1, Sothearos Blvd, Phnom Penh',
      latitude: 11.5449,
      longitude: 104.916,
      street: 'Sothearos Blvd',
      district: 'Tonle Bassac',
      city: 'Phnom Penh',
      state: 'Phnom Penh',
      postcode: '120101',
      countryCode: 'KH',
      category: 'mall',
    },
  ];

  async searchPlaces(query: string, near?: Coordinates, limit = 10): Promise<PlaceResult[]> {
    this.failIfAsked();

    const matches = this.places.filter((place) => place.name.toLowerCase().includes(query.toLowerCase()));
    const results = matches.length > 0 ? matches : this.places;

    return results
      .map((place) =>
        near
          ? {
              ...place,
              distanceMeters: GeoUtil.haversineMeters(near, {
                latitude: place.latitude,
                longitude: place.longitude,
              }),
            }
          : place,
      )
      .slice(0, limit);
  }

  async reverseGeocode(point: Coordinates): Promise<PlaceResult | null> {
    this.failIfAsked();
    return { ...this.places[0], latitude: point.latitude, longitude: point.longitude };
  }

  async getPlace(placeId: string): Promise<PlaceResult | null> {
    this.failIfAsked();
    return this.places.find((place) => place.placeId === placeId) ?? null;
  }

  async getRoute(waypoints: Coordinates[], profile: RoutingProfile): Promise<RouteResult> {
    this.failIfAsked();

    let straightLine = 0;
    for (let index = 1; index < waypoints.length; index += 1) {
      straightLine += GeoUtil.haversineMeters(waypoints[index - 1], waypoints[index]);
    }

    const distanceMeters = Math.round(straightLine * 1.3);
    const speedKmh = profile === 'CAR' ? 22 : 24;

    return {
      distanceMeters,
      durationSeconds: Math.round((distanceMeters / 1000 / speedKmh) * 3_600),
      polyline: 'fake_polyline',
      source: 'roktenh',
    };
  }

  async getDistanceMatrix(
    origin: Coordinates,
    destinations: Coordinates[],
  ): Promise<MatrixResult> {
    this.failIfAsked();

    return {
      distances: destinations.map((destination) =>
        Math.round(GeoUtil.haversineMeters(origin, destination) * 1.3),
      ),
      source: 'roktenh',
    };
  }

  private failIfAsked(): void {
    if (this.shouldFail) {
      throw new Error('map provider is unavailable');
    }
  }
}
