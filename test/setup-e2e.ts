import { existsSync } from 'node:fs';
import path from 'node:path';

// Load the throwaway test database/Redis before Nest reads any config.
const envFile = path.join(process.cwd(), '.env.test');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
process.env.NODE_ENV = 'test';
