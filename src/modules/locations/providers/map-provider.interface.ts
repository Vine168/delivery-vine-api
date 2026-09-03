import type { Coordinates } from '../../../common/utils/geo.util.js';

/** Routing profiles the provider understands. Vehicle types map onto these. */
export type RoutingProfile = 'MOTOR' | 'CAR' | 'CYCLE' | 'FOOT';

export interface PlaceResult {
  /** Stable within the provider: `<osm_type>:<osm_id>`, e.g. `W:687168292`. */
  placeId: string;
  name: string;
  /** One line, ready to show: name, street, district, city. */
  address: string;
  latitude: number;
  longitude: number;
  street: string | null;
  district: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  countryCode: string | null;
  /** OSM category, e.g. `shop` / `mall` — useful for an icon. */
  category: string | null;
  /** Straight-line metres from the search origin, when one was given. */
  distanceMeters?: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  /** Encoded polyline for the map, when the provider returned one. */
  polyline: string | null;
  /** `roktenh` for a real route, `haversine` when we fell back to a straight line. */
  source: 'roktenh' | 'haversine';
}

export interface MatrixResult {
  /** Metres from the origin to each destination, in the order given. */
  distances: number[];
  source: 'roktenh' | 'haversine';
}

/**
 * Everything the platform needs from a map service.
 *
 * Business code depends on this interface only, so the provider can be
 * replaced without touching pricing, matching or booking. The RokTenh
 * specifics — its response envelope, its openrouteservice quirks — stay in the
 * adapter.
 */
export interface MapProvider {
  searchPlaces(query: string, near?: Coordinates, limit?: number): Promise<PlaceResult[]>;
  reverseGeocode(point: Coordinates, radiusMeters?: number): Promise<PlaceResult | null>;
  getPlace(placeId: string): Promise<PlaceResult | null>;
  getRoute(waypoints: Coordinates[], profile: RoutingProfile): Promise<RouteResult>;
  /** Road distance from one origin to many destinations, in a single call. */
  getDistanceMatrix(origin: Coordinates, destinations: Coordinates[], profile: RoutingProfile): Promise<MatrixResult>;
}

export const MAP_PROVIDER = Symbol('MAP_PROVIDER');
