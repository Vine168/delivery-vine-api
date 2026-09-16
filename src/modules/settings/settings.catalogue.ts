/**
 * Every setting an operator may change, declared in code.
 *
 * The store behind this is a key/value table, which on its own would let the
 * back office write keys nothing reads — a settings screen full of controls
 * that quietly do nothing. So the catalogue is the whole surface: a key that
 * is not listed here cannot be written, and a key is only listed here once
 * something actually reads it. Adding a setting means adding its consumer in
 * the same change.
 *
 * Each entry names the environment variable it overrides. The env value is the
 * deployment's default; a stored setting takes precedence at runtime, and
 * clearing it falls back to the env value again.
 */
export type SettingKind = 'integer' | 'boolean';

export interface SettingDefinition {
  key: string;
  category: string;
  label: string;
  description: string;
  kind: SettingKind;
  /** The config path the value falls back to when nothing is stored. */
  configPath: string;
  min?: number;
  max?: number;
  unit?: string;
}

export const SETTINGS_CATALOGUE: SettingDefinition[] = [
  {
    key: 'matching.radiusMeters',
    category: 'Matching',
    label: 'First search radius',
    description: 'How far the first dispatch round looks for a driver. Each round widens by this much again.',
    kind: 'integer',
    configPath: 'delivery.matchingRadiusMeters',
    min: 500,
    max: 30_000,
    unit: 'metres',
  },
  {
    key: 'matching.maxRadiusMeters',
    category: 'Matching',
    label: 'Widest search radius',
    description: 'The search never grows past this, however many rounds it takes.',
    kind: 'integer',
    configPath: 'delivery.matchingMaxRadiusMeters',
    min: 1_000,
    max: 50_000,
    unit: 'metres',
  },
  {
    key: 'matching.batchSize',
    category: 'Matching',
    label: 'Drivers offered per round',
    description:
      'How many drivers see the same job at once. Larger fills faster and rejects more of them; only one can accept.',
    kind: 'integer',
    configPath: 'delivery.matchingBatchSize',
    min: 1,
    max: 20,
    unit: 'drivers',
  },
  {
    key: 'matching.offerTtlSeconds',
    category: 'Matching',
    label: 'Time to accept an offer',
    description: 'How long a driver has to respond before the offer lapses and the next round begins.',
    kind: 'integer',
    configPath: 'delivery.offerTtlSeconds',
    min: 10,
    max: 300,
    unit: 'seconds',
  },
  {
    key: 'matching.maxRounds',
    category: 'Matching',
    label: 'Rounds before giving up',
    description: 'After this many rounds without an acceptance the booking expires and the customer is told.',
    kind: 'integer',
    configPath: 'delivery.maxRounds',
    min: 1,
    max: 10,
    unit: 'rounds',
  },
  {
    key: 'delivery.arrivalRadiusMeters',
    category: 'Operations',
    label: 'Arrival radius',
    description:
      'How close a driver must be before the server accepts that they have arrived. Widen it if honest drivers are being refused in areas with poor GPS.',
    kind: 'integer',
    configPath: 'delivery.arrivalRadiusMeters',
    min: 50,
    max: 5_000,
    unit: 'metres',
  },
  {
    key: 'delivery.stalledAfterMinutes',
    category: 'Operations',
    label: 'Stalled after',
    description:
      'How long a booking may search before the dashboard counts it as stuck and puts it in front of an operator.',
    kind: 'integer',
    configPath: 'delivery.stalledAfterMinutes',
    min: 1,
    max: 120,
    unit: 'minutes',
  },
  {
    key: 'delivery.driverPresenceTtlSeconds',
    category: 'Operations',
    label: 'Driver goes stale after',
    description:
      'How long a driver counts as on the road after their last location report. Too short and drivers drop out of dispatch between reports; too long and jobs are offered to drivers who have closed the app.',
    kind: 'integer',
    configPath: 'delivery.driverPresenceTtlSeconds',
    min: 15,
    max: 600,
    unit: 'seconds',
  },
  {
    key: 'delivery.trackPointMinIntervalSeconds',
    category: 'Operations',
    label: 'Smallest gap between saved track points',
    description:
      'Location reports arriving sooner than this still move the driver on the live map, but are not written to the delivery trail. Lower gives a finer trail and a larger database.',
    kind: 'integer',
    configPath: 'delivery.trackPointMinIntervalSeconds',
    min: 1,
    max: 300,
    unit: 'seconds',
  },
  {
    key: 'otp.ttlSeconds',
    category: 'Verification codes',
    label: 'Code valid for',
    description: 'How long a code works after it is sent. The countdown the app shows comes from this.',
    kind: 'integer',
    configPath: 'otp.ttlSeconds',
    min: 60,
    max: 900,
    unit: 'seconds',
  },
  {
    key: 'otp.maxAttempts',
    category: 'Verification codes',
    label: 'Guesses per code',
    description:
      'After this many wrong guesses the code is destroyed and the person must request another. Raising it makes a six-digit code easier to guess.',
    kind: 'integer',
    configPath: 'otp.maxAttempts',
    min: 1,
    max: 10,
    unit: 'attempts',
  },
  {
    key: 'otp.resendCooldownSeconds',
    category: 'Verification codes',
    label: 'Wait before resending',
    description:
      'How long someone must wait before asking for another code. This is what stops a tapped "resend" button sending two codes and confusing the person about which one to type.',
    kind: 'integer',
    configPath: 'otp.resendCooldownSeconds',
    min: 15,
    max: 600,
    unit: 'seconds',
  },
  {
    key: 'otp.maxPerHour',
    category: 'Verification codes',
    label: 'Codes per hour',
    description:
      'The hourly budget per phone number and purpose. Every code costs money to send, so this is the cap that matters when someone is hammering registration.',
    kind: 'integer',
    configPath: 'otp.maxPerHour',
    min: 1,
    max: 20,
    unit: 'codes',
  },
  {
    key: 'otp.verificationTokenTtlSeconds',
    category: 'Verification codes',
    label: 'Time to finish after verifying',
    description:
      'Once a code is accepted, how long the person has to set or reset their password before they must verify again.',
    kind: 'integer',
    configPath: 'otp.verificationTokenTtlSeconds',
    min: 120,
    max: 3_600,
    unit: 'seconds',
  },
  {
    key: 'map.cacheTtlSeconds',
    category: 'Maps',
    label: 'Place cache lifetime',
    description:
      'How long searched and geocoded places are reused before the map provider is asked again. Longer is faster and cheaper; a place that has since moved or closed stays wrong for this long.',
    kind: 'integer',
    configPath: 'map.cacheTtlSeconds',
    min: 60,
    max: 604_800,
    unit: 'seconds',
  },
  {
    key: 'map.allowHaversineFallback',
    category: 'Maps',
    label: 'Estimate routes during a map outage',
    description:
      'On: if the routing engine is unreachable, distances are estimated in a straight line and marked as estimated, so customers can still book. Off: quoting and booking fail until maps recover.',
    kind: 'boolean',
    configPath: 'map.allowHaversineFallback',
  },
  {
    key: 'payment.paywayLifetimeMinutes',
    category: 'Payments',
    label: 'Checkout window',
    description: 'How long a PayWay checkout stays payable before the customer must start again.',
    kind: 'integer',
    configPath: 'payment.paywayLifetimeMinutes',
    min: 5,
    max: 120,
    unit: 'minutes',
  },
  {
    key: 'payout.minAmountKhr',
    category: 'Payouts',
    label: 'Smallest withdrawal',
    description: 'In riel. Other currencies are converted with the stored exchange rate.',
    kind: 'integer',
    configPath: 'payout.minAmountKhr',
    min: 0,
    max: 10_000_000,
    unit: 'KHR',
  },
  {
    key: 'payout.maxAmountKhr',
    category: 'Payouts',
    label: 'Largest withdrawal',
    description: 'In riel, per request. A driver with more than this withdraws it over several requests.',
    kind: 'integer',
    configPath: 'payout.maxAmountKhr',
    min: 0,
    max: 100_000_000,
    unit: 'KHR',
  },
  {
    key: 'payout.feeKhr',
    category: 'Payouts',
    label: 'Withdrawal fee',
    description: 'In riel, deducted from the amount the driver receives.',
    kind: 'integer',
    configPath: 'payout.feeKhr',
    min: 0,
    max: 1_000_000,
    unit: 'KHR',
  },
];

export const SETTINGS_BY_KEY = new Map(SETTINGS_CATALOGUE.map((setting) => [setting.key, setting]));
