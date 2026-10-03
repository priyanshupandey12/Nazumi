import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// Separate config so `drizzle-kit migrate` can target the test database
// without the dev .env winning.
const env = config({ path: '.env.test' }).parsed ?? {};

export default defineConfig({
  out: './drizzle',
  schema: './src/db/Schema.ts',
  dialect: 'postgresql',
  dbCredentials: { url: env.DATABASE_URL },
});
