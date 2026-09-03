import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ResponseCode } from '../../common/constants/response-codes.js';
import { AppException } from '../../common/exceptions/app.exception.js';
import { GeoUtil, type Coordinates } from '../../common/utils/geo.util.js';
import {
  MAP_PROVIDER,
  type MapProvider,
  type MatrixResult,
  type RouteResult,
  type RoutingProfile,
} from './providers/map-provider.interface.js';
import type { LocationDto, ReverseGeocodeQueryDto, SearchLocationsQueryDto } from './dto/location.dto.js';

/** Rough road speeds, used only when the routing engine is unreachable. */
const FALLBACK_SPEED_KMH: Record<RoutingProfile, number> = {
  MOTOR: 24,
  CAR: 22,
  CYCLE: 14,
  FOOT: 5,
};

/** Streets are not straight; straight-line distance under-reports by roughly this. */
const ROAD_WINDING_FACTOR = 1.3;

/**
 * The application's view of "a place".
 *
 * Everything else in the system asks this service, never the provider, so the
 * map vendor is a single swap in LocationsModule.
 */
@Injectable()
export class LocationsService {
  private readonly logger = new Logger(LocationsService.name);
  private readonly allowFallback: boolean;

  constructor(
    @Inject(MAP_PROVIDER) private readonly maps: MapProvider,
    config: ConfigService,
  ) {
    this.allowFallback = config.get<boolean>('map.allowHaversineFallback', true);
  }

  async search(query: SearchLocationsQueryDto): Promise<LocationDto[]> {
    const near =
      query.latitude !== undefined && query.longitude !== undefined
        ? { latitude: query.latitude, longitude: query.longitude }
        : undefined;

    return this.maps.searchPlaces(query.query, near, query.limit);
  }

  async reverseGeocode(query: ReverseGeocodeQueryDto): Promise<LocationDto> {
    const place = await this.maps.reverseGeocode(
      { latitude: query.latitude, longitude: query.longitude },
      query.radiusMeters,
    );

    if (!place) {
      throw AppException.notFound(ResponseCode.LOCATION_NOT_FOUND, 'No address found at that point.');
    }

    return place;
  }

  async getPlace(placeId: string): Promise<LocationDto> {
    const place = await this.maps.getPlace(placeId);

    if (!place) {
      // The provider has no detail endpoint: ids come from a search, and the
      // cache behind them expires. The client should search again.
      throw AppException.notFound(
        ResponseCode.LOCATION_NOT_FOUND,
        'That place is no longer available. Please search again.',
      );
    }

    return place;
  }

  /**
   * A route, or a usable approximation.
   *
   * A customer waiting to book should not be blocked because the routing
   * engine is having a bad afternoon, so an outage degrades to straight-line
   * distance × a winding factor, clearly labelled `haversine` so the caller —
   * and the stored pricing snapshot — knows the number was estimated.
   * Set MAP_ALLOW_HAVERSINE_FALLBACK=false to fail closed instead.
   */
  async route(waypoints: Coordinates[], profile: RoutingProfile): Promise<RouteResult> {
    try {
      return await this.maps.getRoute(waypoints, profile);
    } catch (error) {
      return this.estimateRoute(waypoints, profile, error);
    }
  }

  async distanceMatrix(
    origin: Coordinates,
    destinations: Coordinates[],
    profile: RoutingProfile,
  ): Promise<MatrixResult> {
    try {
      return await this.maps.getDistanceMatrix(origin, destinations, profile);
    } catch (error) {
      this.rethrowIfClosed(error);
      this.logger.warn(`Distance matrix unavailable, estimating: ${String(error)}`);

      return {
        distances: destinations.map((destination) =>
          Math.round(GeoUtil.haversineMeters(origin, destination) * ROAD_WINDING_FACTOR),
        ),
        source: 'haversine',
      };
    }
  }

  private estimateRoute(waypoints: Coordinates[], profile: RoutingProfile, error: unknown): RouteResult {
    this.rethrowIfClosed(error);
    this.logger.warn(`Route unavailable, estimating: ${String(error)}`);

    let straightLine = 0;
    for (let index = 1; index < waypoints.length; index += 1) {
      straightLine += GeoUtil.haversineMeters(waypoints[index - 1], waypoints[index]);
    }

    const distanceMeters = Math.round(straightLine * ROAD_WINDING_FACTOR);

    return {
      distanceMeters,
      durationSeconds: Math.round((distanceMeters / 1000 / FALLBACK_SPEED_KMH[profile]) * 3_600),
      polyline: null,
      source: 'haversine',
    };
  }

  /**
   * "No route exists between these points" is a real answer, not an outage —
   * estimating a straight line over it would invent a delivery that cannot
   * happen. Only transport failures are estimated around.
   */
  private rethrowIfClosed(error: unknown): void {
    if (error instanceof AppException && error.code === ResponseCode.ROUTE_NOT_FOUND) {
      throw error;
    }
    if (!this.allowFallback) {
      throw AppException.serviceUnavailable(ResponseCode.MAP_PROVIDER_UNAVAILABLE);
    }
  }
}
