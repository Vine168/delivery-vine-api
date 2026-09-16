/**
 * Environment variables that may be kept in the database instead of a file.
 *
 * Like the settings catalogue, this is the whole surface: a key that is not
 * listed here is never read from the database and cannot be written by the
 * CLI, so a typo cannot quietly shadow a real variable.
 *
 * Two variables can never appear here, and the loader refuses to start if they
 * do:
 *
 *   DATABASE_URL         is how this table is reached
 *   SECRETS_MASTER_KEY   is what decrypts the values in it
 *
 * Everything else about the platform's own behaviour — ports, log levels,
 * feature switches — stays in the environment because it is not secret, and
 * operator-tunable numbers belong in SystemSetting instead.
 */
export interface SecretDefinition {
  /** The environment variable this supplies. */
  key: string;
  description: string;
}

export const SECRETS_CATALOGUE: SecretDefinition[] = [
  // ── Tokens and field encryption ──
  { key: 'JWT_ACCESS_SECRET', description: 'Signs access tokens. Rotating it signs every caller out.' },
  { key: 'JWT_REFRESH_SECRET', description: 'Signs refresh tokens. Must differ from the access secret.' },
  {
    key: 'ENCRYPTION_KEY',
    description:
      'Encrypts bank account and document numbers. Rotating it requires re-encrypting every stored value first.',
  },

  // ── Object storage ──
  { key: 'STORAGE_ENDPOINT', description: 'MinIO / S3 host.' },
  { key: 'STORAGE_PORT', description: 'MinIO / S3 port.' },
  { key: 'STORAGE_USE_SSL', description: 'Whether object storage is reached over TLS.' },
  { key: 'STORAGE_ACCESS_KEY', description: 'Object storage access key.' },
  { key: 'STORAGE_SECRET_KEY', description: 'Object storage secret key.' },
  { key: 'STORAGE_BUCKET', description: 'Bucket holding private uploads.' },
  { key: 'STORAGE_PUBLIC_BUCKET', description: 'Bucket holding publicly readable files.' },
  { key: 'STORAGE_REGION', description: 'Object storage region.' },

  // ── Maps ──
  { key: 'MAP_API_KEY', description: 'RokTenh map provider key.' },

  // ── Push notifications ──
  { key: 'FCM_PROJECT_ID', description: 'Firebase project id.' },
  { key: 'FCM_CLIENT_EMAIL', description: 'Firebase service account address.' },
  { key: 'FCM_PRIVATE_KEY', description: 'Firebase service account private key.' },

  // ── Payments ──
  { key: 'PAYWAY_API_KEY', description: 'ABA PayWay key, used to sign every request.' },

  // ── SMS gateway ──
  { key: 'PLASGATE_BASE_URL', description: 'PlasGate endpoint.' },
  { key: 'PLASGATE_PRIVATE_KEY', description: 'PlasGate private key.' },
  {
    key: 'PLASGATE_SECRET_KEY',
    description: 'PlasGate secret key. Stored verbatim here, so the $ escaping a .env file needs does not apply.',
  },
  { key: 'PLASGATE_SENDER', description: 'Sender name shown on the message.' },

  // ── Back office ──
  { key: 'SWAGGER_PASSWORD', description: 'Password for the API documentation.' },
  { key: 'ADMIN_BOOTSTRAP_PHONE', description: 'Phone for the first back-office account, used only by the seed.' },
  { key: 'ADMIN_BOOTSTRAP_PASSWORD', description: 'Password for that account, used only by the seed.' },
];

/** Never storable: the loader needs both before it can read anything. */
export const NEVER_STORED = ['DATABASE_URL', 'SECRETS_MASTER_KEY'] as const;

export const SECRETS_BY_KEY = new Map(SECRETS_CATALOGUE.map((secret) => [secret.key, secret]));
