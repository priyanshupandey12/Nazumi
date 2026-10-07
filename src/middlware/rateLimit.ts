import type { NextFunction, Request, Response } from "express";
import { redis } from "../lib/redis.js";
import { currentUser } from "../lib/access.js";

/**
 * A fixed-window limiter backed by Redis.
 *
 * Redis rather than in-process memory because the limit has to hold across
 * restarts and across however many API instances end up running — an
 * in-memory counter resets on deploy and multiplies by the instance count,
 * which is exactly when a limit matters least.
 *
 * Fixed window rather than a sliding log: it is one INCR per request, and the
 * worst case is a caller getting 2x the limit across a window boundary. For
 * stopping comment spam that is entirely good enough.
 */
export type RateLimitOptions = {
  /** Distinguishes buckets, so one action cannot exhaust another's budget. */
  name: string;
  limit: number;
  windowSeconds: number;
  message?: string;
};

/**
 * Signed-in callers are limited by account, everyone else by address.
 *
 * Keying signed-in users by account rather than IP means a household or office
 * behind one address does not share a budget, while an anonymous flood is
 * still contained.
 */
const identify = async (req: Request): Promise<string> => {
  const user = await currentUser(req).catch(() => null);
  if (user) return `u:${user.id}`;

  const forwarded = req.headers["x-forwarded-for"];
  const ip =
    (typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined) ||
    req.ip ||
    req.socket.remoteAddress ||
    "unknown";

  return `ip:${ip}`;
};

/**
 * Counts one use against a bucket and says whether it is still allowed.
 *
 * Split out of the middleware so the WebSocket chat layer, which never sees an
 * Express request, shares the same counting and the same fail-open behaviour.
 */
export const consume = async (
  name: string,
  identity: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number }> => {
  try {
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `rl:${name}:${identity}:${window}`;

    const [[, count]] = (await redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds, "NX")
      .exec()) as [[Error | null, number], [Error | null, number]];

    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (error) {
    // Fail open, for the same reason the middleware does.
    console.error(`[rateLimit] ${name} unavailable, allowing:`, error);
    return { allowed: true, remaining: limit };
  }
};

export const rateLimit = (options: RateLimitOptions) => {
  const { name, limit, windowSeconds } = options;
  const message =
    options.message ?? "That is a lot of requests. Please slow down and try again.";

  return async (req: Request, res: Response, next: NextFunction) => {
    let count: number;

    try {
      const identity = await identify(req);
      const window = Math.floor(Date.now() / 1000 / windowSeconds);
      const key = `rl:${name}:${identity}:${window}`;

      // INCR then EXPIRE on first use. A pipeline keeps it to one round trip;
      // the EXPIRE is harmless when the key already has a TTL.
      const [[, incremented]] = (await redis
        .multi()
        .incr(key)
        .expire(key, windowSeconds, "NX")
        .exec()) as [[Error | null, number], [Error | null, number]];

      count = incremented;
    } catch (error) {
      // Fail open. A limiter that takes the site down when Redis blinks is
      // worse than the abuse it prevents.
      console.error(`[rateLimit] ${name} unavailable, allowing request:`, error);
      return next();
    }

    const remaining = Math.max(0, limit - count);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(remaining));

    if (count > limit) {
      res.setHeader("Retry-After", String(windowSeconds));
      return res.status(429).json({ message });
    }

    return next();
  };
};

/**
 * The limits themselves, gathered here so they can be read as a policy rather
 * than hunted for across the route files.
 */
export const limits = {
  // Generous enough for a real conversation, low enough to stop a script.
  comment: rateLimit({
    name: "comment",
    limit: 15,
    windowSeconds: 60,
    message: "You are commenting very quickly. Wait a moment and try again.",
  }),
  // A toggle people click around with, so this only catches automation.
  like: rateLimit({ name: "like", limit: 90, windowSeconds: 60 }),
  subscribe: rateLimit({ name: "subscribe", limit: 60, windowSeconds: 60 }),
  // Each upload costs a transcode, so this one is deliberately tight.
  upload: rateLimit({
    name: "upload",
    limit: 12,
    windowSeconds: 3600,
    message: "You have reached the upload limit for this hour.",
  }),
  // Anonymous and cheap, but trivially scriptable into a fake view count.
  view: rateLimit({ name: "view", limit: 120, windowSeconds: 60 }),
  profile: rateLimit({ name: "profile", limit: 20, windowSeconds: 60 }),
  report: rateLimit({
    name: "report",
    limit: 20,
    windowSeconds: 3600,
    message: "You have sent a lot of reports. Please try again later.",
  }),
};
