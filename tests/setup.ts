import { beforeAll, beforeEach, afterAll, vi } from "vitest";
import { rm } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { db } from "../src/db/db.js";
import { videoQueue } from "../src/queue/video.queue.js";
import { redis } from "../src/lib/redis.js";

/**
 * Cloudinary is the one dependency tests must never reach: it is a paid,
 * shared, external service, and the delete path would otherwise fire real
 * requests. Stubbed here rather than per-file so no test can forget.
 */
vi.mock("../src/utils/cloudinary.js", () => ({
  uploadToCloudinary: vi.fn(async () => ({
    secure_url: "https://res.cloudinary.test/image/upload/thumbnails/stub.jpg",
  })),
  uploadRawToCloudinary: vi.fn(async (_path: string, publicId: string) => ({
    secure_url: `https://res.cloudinary.test/raw/upload/${publicId}`,
  })),
  uploadImageToCloudinary: vi.fn(async (_path: string, publicId: string) => ({
    secure_url: `https://res.cloudinary.test/image/upload/${publicId}.jpg`,
  })),
  deleteFromCloudinary: vi.fn(async () => ({ result: "ok" })),
  deleteRawFolderFromCloudinary: vi.fn(async () => ({ deleted: {} })),
  deleteImageFolderFromCloudinary: vi.fn(async () => ({ deleted: {} })),
  publicIdFromUrl: (url: string) => {
    const match = /\/upload\/(?:v\d+\/)?(.+)$/.exec(url);
    return match?.[1]?.replace(/\.[^./]+$/, "") ?? null;
  },
}));

/**
 * Every table the API writes to. All quoted: `user` and `like` are reserved
 * words, and quoting only those two invites the next one to be forgotten.
 */
const TABLES = [
  "comment",
  "like",
  "subscriber",
  "membership",
  "chat_message",
  "video_rendition",
  "video",
  "livestreaming",
  "session",
  "account",
  "verification",
  "user",
].map((table) => `"${table}"`);

export const resetDatabase = async () => {
  await db.execute(
    sql.raw(`TRUNCATE TABLE ${TABLES.join(", ")} RESTART IDENTITY CASCADE`),
  );
};

beforeAll(async () => {
  // A misconfigured run must fail loudly rather than truncate real data.
  const url = process.env.DATABASE_URL ?? "";
  if (!url.includes("streamhub_test")) {
    throw new Error(
      `Refusing to run: DATABASE_URL is not the test database (${url}).`,
    );
  }
  await resetDatabase();
});

/**
 * Rate-limit buckets live in Redis and outlive a single test file. The
 * anonymous ones are keyed by address, so every test shares 127.0.0.1 — a file
 * that exhausts a bucket would throttle whichever file runs next inside the
 * same window.
 */
const resetRateLimits = async () => {
  const keys = await redis.keys("rl:*");
  if (keys.length > 0) await redis.del(...keys);
};

beforeEach(async () => {
  await resetDatabase();
  await resetRateLimits();
});

afterAll(async () => {
  // Jobs queued by upload tests would otherwise outlive the run.
  await videoQueue.obliterate({ force: true }).catch(() => {});
  await videoQueue.close().catch(() => {});
  await redis.quit().catch(() => {});

  // Upload tests write real multipart bodies to disk; nothing else removes
  // them, because the worker that normally would never runs here.
  await rm(process.env.VIDEO_UPLOAD_DIR ?? "./tmp/test-uploads", {
    recursive: true,
    force: true,
  }).catch(() => {});
});
