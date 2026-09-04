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
