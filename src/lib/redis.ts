import type { RedisOptions } from 'bullmq'
import { Redis } from 'ioredis'

const host = process.env.REDIS_HOST as string;
const port = parseInt(process.env.REDIS_PORT as string, 10);
// Tests point at a separate index so a run cannot touch real jobs.
const db = Number(process.env.REDIS_DB ?? 0);

/** Queue connection. Typed by bullmq, which is stricter than ioredis's own. */
export const redisConnection: RedisOptions = { host, port, db };

/**
 * A plain client for everything that is not a queue — currently rate limiting.
 *
 * `lazyConnect` so importing this module opens no socket until something
 * actually needs Redis, with the offline queue left on so the command that
 * triggers the connection waits for it rather than failing. Those two
 * together are the point: `enableOfflineQueue: false` alongside `lazyConnect`
 * makes the very first command fail, which silently disables the limiter
 * until some other code connects the client.
 *
 * `maxRetriesPerRequest: 1` keeps a genuine outage quick to fail instead of
 * stalling every request behind a reconnect.
 */
export const redis = new Redis({
  host,
  port,
  db,
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

// Without a listener an unreachable Redis crashes the process on an error
// event. Rate limiting is allowed to be unavailable, not fatal.
redis.on("error", (error) => {
  console.error("[redis] client error:", error.message);
});
