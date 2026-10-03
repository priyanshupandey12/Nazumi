import { createHmac, randomUUID } from "node:crypto";
import { uuidv7 } from "uuidv7";
import { auth } from "../src/lib/auth.js";
import { db } from "../src/db/db.js";
import { user, video } from "../src/db/Schema.js";
import { createApp } from "../src/app.js";

export const app = createApp();

export type TestUser = {
  id: string;
  name: string;
  email: string;
  cookie: string;
};

/**
 * Creates a user and a signed session cookie for them.
 *
 * The app only authenticates through Google, so tests mint the session the way
 * better-auth does internally rather than driving an OAuth round trip.
 */
export const createUser = async (name = "Test User"): Promise<TestUser> => {
  const id = `u_${randomUUID().slice(0, 12)}`;
  const email = `${id}@example.test`;

  await db.insert(user).values({
    id,
    name,
    email,
    emailVerified: true,
    updatedAt: new Date(),
  });

  const ctx = await auth.$context;
  const session = await ctx.internalAdapter.createSession(id, undefined, false, undefined);
  const signature = createHmac("sha256", ctx.secret).update(session.token).digest("base64");
  const cookie = `${ctx.authCookies.sessionToken.name}=${encodeURIComponent(
    `${session.token}.${signature}`,
  )}`;

  return { id, name, email, cookie };
};

type VideoOverrides = Partial<typeof video.$inferInsert>;

/** A published, playable video unless the overrides say otherwise. */
export const createVideo = async (
  creatorId: string,
  overrides: VideoOverrides = {},
) => {
  const [row] = await db
    .insert(video)
    .values({
      id: uuidv7(),
      creatorId,
      title: "A test video",
      description: null,
      status: "ready",
      isPublished: true,
      videoUrl: "https://res.cloudinary.test/raw/upload/master.m3u8",
      duration: 120,
      ...overrides,
    })
    .returning();

  return row!;
};

/** Ids are uuidv7, so creating in order gives a predictable newest-first feed. */
export const createVideos = async (
  creatorId: string,
  rows: VideoOverrides[],
) => {
  const created = [];
  for (const row of rows) created.push(await createVideo(creatorId, row));
  return created;
};
