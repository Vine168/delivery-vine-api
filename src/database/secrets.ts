import { existsSync } from 'node:fs';
import path from 'node:path';
import { PrismaPg } from '@prisma/adapter-pg';
import { CryptoUtil } from '../common/utils/crypto.util.js';
import { SECRETS_BY_KEY, SECRETS_CATALOGUE } from '../config/secrets.catalogue.js';
import { isNeverStored } from '../config/secrets.loader.js';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Manages the secrets the application reads at boot.
 *
 * Deliberately a command-line tool and not an admin screen: these are read
 * once at startup and never needed again at runtime, so an HTTP endpoint would
 * add a way to read them out without adding a way to use them.
 *
 *   npm run db:secrets -- list
 *   npm run db:secrets -- set JWT_ACCESS_SECRET "<value>"
 *   npm run db:secrets -- unset JWT_ACCESS_SECRET
 *   npm run db:secrets -- import          # move everything from .env
 */
const envFile = process.env.NODE_ENV === 'test' ? '.env.test' : '.env';
const envPath = path.join(process.cwd(), envFile);
if (existsSync(envPath)) {
  process.loadEnvFile(envPath);
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL, options: '-c timezone=UTC' }),
});

function masterKey(): string {
  const key = process.env.SECRETS_MASTER_KEY;
  if (!key) {
    throw new Error(
      'SECRETS_MASTER_KEY is not set. Generate one with:  openssl rand -base64 48\n' +
        'Keep it in the environment — it is what decrypts everything this tool writes.',
    );
  }
  return key;
}

/** Enough to recognise a value, not enough to use it. */
function mask(value: string): string {
  if (value.length <= 8) return '•'.repeat(value.length);
  return `${value.slice(0, 3)}${'•'.repeat(Math.min(value.length - 6, 20))}${value.slice(-3)}`;
}

function assertKnown(key: string): void {
  if (isNeverStored(key)) {
    throw new Error(
      `${key} cannot be stored in the database: it is needed to reach and read the database in the first place.`,
    );
  }
  if (!SECRETS_BY_KEY.has(key)) {
    throw new Error(
      `${key} is not a secret this platform reads.\nKnown keys:\n${SECRETS_CATALOGUE.map((s) => `  ${s.key}`).join('\n')}`,
    );
  }
}

async function list(): Promise<void> {
  const rows = await prisma.appSecret.findMany({ select: { key: true, valueEnc: true, updatedAt: true } });
  const stored = new Map(rows.map((row) => [row.key, row]));
  const key = rows.length > 0 ? masterKey() : '';

  console.log(`${'KEY'.padEnd(28)} ${'DATABASE'.padEnd(30)} ENVIRONMENT`);

  for (const secret of SECRETS_CATALOGUE) {
    const row = stored.get(secret.key);
    let inDatabase = '—';

    if (row) {
      try {
        inDatabase = mask(CryptoUtil.decrypt(row.valueEnc, key));
      } catch {
        inDatabase = '(wrong master key)';
      }
    }

    // What the environment holds matters: it wins over the database, so a
    // value here explains why a changed row appears to do nothing.
    const fromEnv = process.env[secret.key];
    const inEnv = fromEnv ? `set — overrides the database` : '—';

    console.log(`${secret.key.padEnd(28)} ${inDatabase.padEnd(30)} ${inEnv}`);
  }
}

async function set(key: string, value: string): Promise<void> {
  assertKnown(key);
  if (value === '') throw new Error('Refusing to store an empty value. Use "unset" to remove it.');

  const valueEnc = CryptoUtil.encrypt(value, masterKey());
  const description = SECRETS_BY_KEY.get(key)?.description;

  await prisma.appSecret.upsert({
    where: { key },
    create: { key, valueEnc, description },
    update: { valueEnc, description },
  });

  console.log(`stored ${key} (${mask(value)})`);
  if (process.env[key]) {
    console.log(`note: ${key} is also set in ${envFile}, and that wins. Remove it there to use the stored value.`);
  }
}

async function unset(key: string): Promise<void> {
  const { count } = await prisma.appSecret.deleteMany({ where: { key } });
  console.log(count > 0 ? `removed ${key}` : `${key} was not stored`);
}

/**
 * Moves everything the environment currently holds into the database, so
 * adopting this is one command rather than twenty.
 *
 * Existing rows are left alone: re-running after a deliberate change must not
 * quietly put the old value back.
 */
async function importFromEnv(): Promise<void> {
  const existing = new Set(
    (await prisma.appSecret.findMany({ select: { key: true } })).map((row) => row.key),
  );
  const key = masterKey();
  let written = 0;

  for (const secret of SECRETS_CATALOGUE) {
    const value = process.env[secret.key];
    if (!value || existing.has(secret.key)) continue;

    await prisma.appSecret.create({
      data: { key: secret.key, valueEnc: CryptoUtil.encrypt(value, key), description: secret.description },
    });
    console.log(`  + ${secret.key}  ${mask(value)}`);
    written += 1;
  }

  console.log(
    written > 0
      ? `\nstored ${written} secret(s) from ${envFile}\n` +
          `Now remove those lines from ${envFile} — while they are there they take precedence.`
      : `nothing to store; every secret in ${envFile} already has a row`,
  );
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'list':
      await list();
      break;
    case 'set':
      if (args.length < 2) throw new Error('Usage: db:secrets -- set <KEY> <value>');
      await set(args[0], args.slice(1).join(' '));
      break;
    case 'unset':
      if (args.length < 1) throw new Error('Usage: db:secrets -- unset <KEY>');
      await unset(args[0]);
      break;
    case 'import':
      await importFromEnv();
      break;
    default:
      console.log('Usage:\n  list\n  set <KEY> <value>\n  unset <KEY>\n  import');
      process.exitCode = 1;
  }
}

await main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
