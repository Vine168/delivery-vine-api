/**
 * Every Redis key the application uses, in one place, so TTLs and key shapes
 * can be reasoned about without grepping. The ioredis client is created with a
 * global prefix, so these are namespace-relative.
 */
export const RedisKey = {
  // ── OTP ──
  otpCode: (purpose: string, identifier: string) => `otp:${purpose}:${identifier}`,
  otpResendCooldown: (purpose: string, identifier: string) => `otp:cooldown:${purpose}:${identifier}`,
  otpHourlyCounter: (purpose: string, identifier: string) => `otp:hourly:${purpose}:${identifier}`,
  otpVerificationToken: (token: string) => `otp:verification:${token}`,

  // ── Rate limiting ──
  rateLimit: (bucket: string, subject: string) => `rl:${bucket}:${subject}`,

  // ── Driver presence & location ──
  /** GEO set of ONLINE drivers, one per vehicle type code. */
  driverGeoIndex: (vehicleTypeCode: string) => `geo:drivers:${vehicleTypeCode}`,
  /** Heartbeat key; its TTL is what makes a driver "present". */
  driverPresence: (driverId: string) => `presence:driver:${driverId}`,
  /** Latest GPS fix, read by the customer tracking endpoint. */
  driverLocation: (driverId: string) => `loc:driver:${driverId}`,
  /** Set of driver ids currently holding an active delivery. */
  driversBusy: 'presence:busy',

  // ── Matching ──
  matchingLock: (deliveryId: string) => `lock:matching:${deliveryId}`,
  acceptLock: (deliveryId: string) => `lock:accept:${deliveryId}`,
  offerredDrivers: (deliveryId: string) => `matching:offered:${deliveryId}`,
  driverOffers: (driverId: string) => `matching:driver-offers:${driverId}`,

  // ── Map provider cache ──
  mapPlaceSearch: (query: string) => `map:place:${query}`,
  mapPlaceDetail: (placeId: string) => `map:place-detail:${placeId}`,
  /** Cached system settings, read on the matching hot path. */
  systemSettings: 'settings:all',

  mapGeocode: (lat: string, lon: string) => `map:geocode:${lat}:${lon}`,
  mapRoute: (hash: string) => `map:route:${hash}`,

  // ── Misc ──
  bookingCodeSequence: (date: string) => `seq:booking:${date}`,
  socketUserRooms: (userId: string) => `ws:user:${userId}`,
  trackPointThrottle: (deliveryId: string) => `throttle:track:${deliveryId}`,
} as const;
