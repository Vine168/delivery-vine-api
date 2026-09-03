import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { RedisKey } from '../../../common/constants/redis-keys.js';
import { ResponseCode } from '../../../common/constants/response-codes.js';
import { AppException } from '../../../common/exceptions/app.exception.js';
import { CryptoUtil } from '../../../common/utils/crypto.util.js';
import { GeoUtil, type Coordinates } from '../../../common/utils/geo.util.js';
import { RedisService } from '../../../redis/redis.service.js';
import type {
  MapProvider,
  MatrixResult,
  PlaceResult,
  RouteResult,
  RoutingProfile,
} from './map-provider.interface.js';

/** The provider wraps everything in this envelope; `code` is "200" on success. */
interface MapEnvelope<T> {
  code: string;
  message: string;
  data: T;
  request_id?: string;
  trace_id?: string;
}

interface GeoJsonFeature {
  geometry: { coordinates: [number, number]; type: string };
  properties: {
    osm_id?: number;
    osm_type?: string;
    osm_key?: string;
    osm_value?: string;
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
    countrycode?: string;
  };
}

interface FeatureCollection {
  features?: GeoJsonFeature[];
}

interface DirectionResponse {
  routes?: {
    summary: { distance: number; duration: number };
    geometry?: string;
  }[];
}

interface MatrixResponse {
  distances?: number[][];
  durations?: number[][];
}

/**
 * RokTenh map adapter.
 *
 * Notes learned from the live API, kept here so nothing else has to know:
 *  • Authorisation is the raw API key with no `Bearer` prefix.
 *  • Success is `code: "200"` (a string) or `"success"`, not an HTTP status alone.
 *  • `GET /direction` returns GeoJSON features; `POST /direction` returns
 *    `routes[]` with a summary — we always POST.
 *  • The engine is openrouteservice, so `/matrix` requires `units` as well as
 *    `metrics`; omitting it fails deep inside the engine with a 400.
 *  • There is no place-details endpoint, so search results are cached and
 *    `getPlace` reads that cache.
 *
 * When the provider is unreachable this throws. Deciding whether a customer
 * still gets an approximate quote is LocationsService's call, not the
 * adapter's — otherwise every future provider would have to reimplement it.
 */
@Injectable()
export class RoktenhMapProvider implements MapProvider {
  private readonly logger = new Logger(RoktenhMapProvider.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly cacheTtl: number;

  constructor(
    private readonly http: HttpService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.baseUrl = config.getOrThrow<string>('map.baseUrl');
    this.apiKey = config.getOrThrow<string>('map.apiKey');
    this.timeoutMs = config.get<number>('map.timeoutMs', 8000);
    this.cacheTtl = config.get<number>('map.cacheTtlSeconds', 86_400);
  }

  // ── Places ─────────────────────────────────────────────────────────────

  async searchPlaces(query: string, near?: Coordinates, limit = 10): Promise<PlaceResult[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) return [];

    const cacheKey = RedisKey.mapPlaceSearch(CryptoUtil.sha256(trimmed.toLowerCase()));
    const cached = await this.redis.getJson<PlaceResult[]>(cacheKey);

    const places =
      cached ??
      this.toPlaces(
        await this.get<FeatureCollection>('/om/v1/place', { query: trimmed }),
      );

    if (!cached && places.length > 0) {
      await this.redis.setJson(cacheKey, places, this.cacheTtl);
      await this.cachePlaces(places);
    }

    const ranked = near
      ? places
          .map((place) => ({
            ...place,
            distanceMeters: GeoUtil.haversineMeters(near, {
              latitude: place.latitude,
              longitude: place.longitude,
            }),
          }))
          .sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0))
      : places;

    return ranked.slice(0, limit);
  }

  async reverseGeocode(point: Coordinates, radiusMeters = 50): Promise<PlaceResult | null> {
    const cacheKey = RedisKey.mapGeocode(point.latitude.toFixed(5), point.longitude.toFixed(5));
    const cached = await this.redis.getJson<PlaceResult>(cacheKey);
    if (cached) return cached;

    const collection = await this.get<FeatureCollection>('/om/v1/geocode', {
      lat: String(point.latitude),
      lon: String(point.longitude),
      radius: String(Math.max(1, Math.round(radiusMeters / 10))),
    });

    const place = this.toPlaces(collection)[0] ?? null;

    if (place) {
      await this.redis.setJson(cacheKey, place, this.cacheTtl);
      await this.cachePlaces([place]);
    }

    return place;
  }

  /** Reads the cache populated by search and reverse geocoding. */
  async getPlace(placeId: string): Promise<PlaceResult | null> {
    return this.redis.getJson<PlaceResult>(RedisKey.mapPlaceDetail(placeId));
  }

  // ── Routing ────────────────────────────────────────────────────────────

  async getRoute(waypoints: Coordinates[], profile: RoutingProfile): Promise<RouteResult> {
    if (waypoints.length < 2) {
      throw AppException.badRequest(ResponseCode.VALIDATION_ERROR, 'A route needs at least two points.');
    }

    const cacheKey = RedisKey.mapRoute(
      CryptoUtil.sha256(`${profile}:${waypoints.map((w) => GeoUtil.cacheKeyFor(w)).join('|')}`),
    );
    const cached = await this.redis.getJson<RouteResult>(cacheKey);
    if (cached) return cached;

    try {
      const response = await this.post<DirectionResponse>('/om/v1/direction', {
        data: {
          coordinates: waypoints.map((point) => ({ lat: point.latitude, lon: point.longitude })),
          profile,
        },
      });

      const route = response.routes?.[0];
      if (!route) {
        throw AppException.unprocessable(ResponseCode.ROUTE_NOT_FOUND, 'No route between those points.');
      }

      const result: RouteResult = {
        distanceMeters: Math.round(route.summary.distance),
        durationSeconds: Math.round(route.summary.duration),
        polyline: route.geometry ?? null,
        source: 'roktenh',
      };

      // Only real routes are cached; a fallback must be retried next time.
      await this.redis.setJson(cacheKey, result, 3_600);
      return result;
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.warn(`Route lookup failed: ${String(error)}`);
      throw AppException.serviceUnavailable(ResponseCode.MAP_PROVIDER_UNAVAILABLE);
    }
  }

  async getDistanceMatrix(
    origin: Coordinates,
    destinations: Coordinates[],
    profile: RoutingProfile,
  ): Promise<MatrixResult> {
    if (destinations.length === 0) {
      return { distances: [], source: 'roktenh' };
    }

    try {
      const locations = [origin, ...destinations].map((point) => ({
        lat: point.latitude,
        lon: point.longitude,
      }));

      const response = await this.post<MatrixResponse>('/om/v1/matrix', {
        data: {
          locations,
          sources: [0],
          destinations: destinations.map((_, index) => index + 1),
          profile,
          metrics: ['distance', 'duration'],
          // openrouteservice rejects the request outright without this.
          units: 'm',
        },
      });

      const row = response.distances?.[0];
      if (!row || row.length !== destinations.length) {
        throw new Error('matrix returned an unexpected shape');
      }

      return { distances: row.map((metres) => Math.round(metres)), source: 'roktenh' };
    } catch (error) {
      if (error instanceof AppException) throw error;
      this.logger.warn(`Distance matrix failed: ${String(error)}`);
      throw AppException.serviceUnavailable(ResponseCode.MAP_PROVIDER_UNAVAILABLE);
    }
  }

  // ── HTTP plumbing ──────────────────────────────────────────────────────

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const response = await firstValueFrom(
      this.http.get<MapEnvelope<T>>(`${this.baseUrl}${path}`, {
        params,
        // The provider takes the raw key — a `Bearer` prefix is rejected.
        headers: { Authorization: this.apiKey, Accept: 'application/json' },
        timeout: this.timeoutMs,
      }),
    );

    return this.unwrap(response.data, path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const response = await firstValueFrom(
      this.http.post<MapEnvelope<T>>(`${this.baseUrl}${path}`, body, {
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        timeout: this.timeoutMs,
      }),
    );

    return this.unwrap(response.data, path);
  }

  private unwrap<T>(envelope: MapEnvelope<T>, path: string): T {
    if (envelope.code !== '200' && envelope.code !== 'success') {
      this.logger.warn(`Map ${path} returned ${envelope.code}: ${envelope.message} (trace ${envelope.trace_id})`);
      throw AppException.serviceUnavailable(ResponseCode.MAP_PROVIDER_UNAVAILABLE, envelope.message);
    }

    return envelope.data;
  }

  // ── Mapping ────────────────────────────────────────────────────────────

  private toPlaces(collection: FeatureCollection | null): PlaceResult[] {
    return (collection?.features ?? [])
      .filter((feature) => Array.isArray(feature.geometry?.coordinates))
      .map((feature) => this.toPlace(feature));
  }

  private toPlace(feature: GeoJsonFeature): PlaceResult {
    const properties = feature.properties ?? {};
    const [longitude, latitude] = feature.geometry.coordinates;

    const street = [properties.housenumber, properties.street].filter(Boolean).join(' ') || null;
    const parts = [properties.name, street, properties.district, properties.city, properties.state].filter(
      (part): part is string => Boolean(part),
    );

    return {
      placeId: `${properties.osm_type ?? 'N'}:${properties.osm_id ?? `${latitude},${longitude}`}`,
      name: properties.name ?? street ?? properties.city ?? 'Unnamed place',
      address: [...new Set(parts)].join(', '),
      latitude,
      longitude,
      street,
      district: properties.district ?? null,
      city: properties.city ?? null,
      state: properties.state ?? null,
      postcode: properties.postcode ?? null,
      countryCode: properties.countrycode ?? null,
      category: properties.osm_value ?? properties.osm_key ?? null,
    };
  }

  /** There is no detail endpoint, so search results become the detail cache. */
  private async cachePlaces(places: PlaceResult[]): Promise<void> {
    await Promise.all(
      places.map((place) => this.redis.setJson(RedisKey.mapPlaceDetail(place.placeId), place, this.cacheTtl)),
    );
  }
}
