import 'dotenv/config';
import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  out: './drizzle',
  // Must match the file's real casing — this resolves on Windows either way,
  // but a lowercase path fails on Linux/CI.
  schema: './src/db/Schema.ts',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});