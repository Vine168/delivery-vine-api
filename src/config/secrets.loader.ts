import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { CryptoUtil } from '../common/utils/crypto.util.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { NEVER_STORED, SECRETS_CATALOGUE } from './secrets.catalogue.js';

/**
 * Fills in secrets from the database before the application is built.
 *
 * Everything downstream — every `registerAs` factory, `validateEnv`, every
 * `config.get(...)` — keeps reading `process.env` exactly as it always has.
 * This only populates the variables that are missing from it, which is what
 * lets the whole change stop at the edge of the application.
 *
 * A value present in the environment always wins, so `.env` still overrides
 * the database on a laptop, and an operator can pin a value on one host
 * without touching the shared row.
 *
 * Must be awaited before `NestFactory.create()` or `Test.createTestingModule`,
 * because configuration is validated while the module graph is constructed and
 * there is no opportunity to await anything by then.
 */
export async function loadSecretsIntoEnv(): Promise<void> {
  loadEnvFiles();

  // The master key is the switch. Without one there is nothing to decrypt, so
  // this deployment keeps its configuration in the environment — the path the
  // test suite takes, and any installation that never adopts the store. It
  // must not be an error: a blank FCM or PayWay key is a normal state, not a
  // sign that something should have been fetched.
  const masterKey = process.env.SECRETS_MASTER_KEY;
  if (!isSet(masterKey)) return;

  // Blank counts as absent. Anything still unset once this has run is
  // env.validation.ts's business — it is the one place that decides what this
  // particular deployment actually requires.
  const missing = SECRETS_CATALOGUE.filter((secret) => !isSet(process.env[secret.key]));
  if (missing.length === 0) return;

  const connectionString = process.env.DATABASE_URL;
  if (!isSet(connectionString)) {
    throw new Error('DATABASE_URL is not set, so secrets cannot be read from the database.');
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString, options: '-c timezone=UTC' }),
  });

  try {
    const rows = await prisma.appSecret.findMany({
      where: { key: { in: missing.map((secret) => secret.key) } },
      select: { key: true, valueEnc: true },
    });

    for (const row of rows) {
      process.env[row.key] = decrypt(row.key, row.valueEnc, masterKey);
    }

    // Left unset rather than reported: plenty of these are legitimately blank
    // (no Firebase project, no PayWay account yet), and env.validation.ts is
    // the one place that decides what this deployment actually requires.
  } finally {
    await prisma.$disconnect();
  }
}

function decrypt(key: string, valueEnc: string, masterKey: string): string {
  try {
    return CryptoUtil.decrypt(valueEnc, masterKey);
  } catch {
    // Never echo the ciphertext or the key: this runs at boot, and boot output
    // is the least private place in the system.
    throw new Error(
      `${key} could not be decrypted. SECRETS_MASTER_KEY does not match the key its value was written with.`,
    );
  }
}

/**
 * The same files, in the same order, that ConfigModule will read a moment
 * later — so "is this already set?" means the same thing here as it will
 * there. Without this every variable would look missing, because Nest has not
 * loaded the .env file yet.
 */
function loadEnvFiles(): void {
  const files = process.env.NODE_ENV === 'test' ? ['.env.test'] : ['.env.local', '.env'];

  for (const file of files) {
    const fullPath = path.join(process.cwd(), file);
    if (!existsSync(fullPath)) continue;

    try {
      process.loadEnvFile(fullPath);
    } catch {
      // Unparseable or unreadable: ConfigModule reports it far better than a
      // pre-boot helper can, so let it get that far.
    }
  }
}

const isSet = (value: string | undefined): value is string => value !== undefined && value !== '';

/**
 * A key that can never come from the store. Exported for the CLI, which must
 * refuse to write one for the same reason the loader must refuse to read it.
 */
export const isNeverStored = (key: string): boolean => (NEVER_STORED as readonly string[]).includes(key);
