import { NestFactory } from '@nestjs/core';
import { loadSecretsIntoEnv } from '../config/secrets.loader.js';
import { SettingsService } from '../modules/settings/settings.service.js';

/**
 * Materialises the settings catalogue as rows.
 *
 * The settings table records overrides, so a fresh database holds nothing and
 * every value comes from the deployment's own configuration. That is correct,
 * but it is hard to inspect: nothing in the database says what the platform is
 * actually running with. This writes one row per catalogue key at the value
 * already in force, so all of them can be read — and changed — in one place.
 *
 * Idempotent. A key that already has a row is left exactly as it is, so this
 * never overwrites something an operator changed, and it is safe to run again
 * after new settings are added to the catalogue.
 *
 *   npm run db:seed:settings
 */
async function main(): Promise<void> {
  await loadSecretsIntoEnv();

  // Imported after the secrets, never at the top. See the note in main.ts.
  const { AppModule } = await import('../app.module.js');

  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const settings = app.get(SettingsService);

  const { created, existing } = await settings.seedDefaults();

  for (const key of created) {
    console.log(`  + ${key}`);
  }

  console.log(
    created.length > 0
      ? `\nwrote ${created.length} setting(s); ${existing} already had a row`
      : `nothing to write; all ${existing} setting(s) already have a row`,
  );

  await app.close();
}

await main().catch((error: unknown) => {
  console.error('Could not seed the settings:', error);
  process.exit(1);
});
