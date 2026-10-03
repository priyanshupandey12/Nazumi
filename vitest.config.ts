import { defineConfig } from "vitest/config";
import { config } from "dotenv";

// Applied to process.env before any test module loads, so the `dotenv/config`
// imports inside src/ find these already set and leave them alone — dotenv does
// not overwrite existing variables. That is what keeps tests off the dev database.
const testEnv = config({ path: ".env.test" }).parsed ?? {};

export default defineConfig({
  test: {
    env: testEnv,
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    // The API tests share one database, so they cannot run in parallel.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
