import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { livestreaming, user } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { identityColumns, toPublicIdentity } from "../lib/identity.js";

/*

  OBS
  |
  | rtmp://host:1935/<streamKey>
  v
MediaMTX
  |
  +---- POST /live/auth  -> is this key real?
  |
  +---- HLS on :8888/<streamKey>/index.m3u8
  |
  v
Worker polls MediaMTX's control API and flips status live/ended

*/

const RTMP_URL = process.env.MEDIA_RTMP_URL ?? "rtmp://localhost:1935";
const HLS_BASE = process.env.MEDIA_HLS_BASE ?? "http://localhost:8888";

const MAX_TITLE = 140;

/**
 * A stream key is a bearer credential typed into OBS, so it is generated
 * rather than derived from anything guessable, and can be rotated if it leaks.
 */
const newStreamKey = () => `live_${randomBytes(18).toString("hex")}`;

const playbackUrlFor = (streamKey: string) =>
  `${HLS_BASE}/${encodeURIComponent(streamKey)}/index.m3u8`;

/*

  MediaMTX
  |
  | POST /live/auth  { action, path, ... }
  v
publish -> the path must be a real stream key
read    -> anyone may watch
  |
  v
200 to allow, 401 to refuse

*/

const authorizeStream = async (req: Request, res: Response) => {
  const { action, path } = req.body ?? {};

  // Reading is public: a live stream is as public as a published video.
  if (action !== "publish") {
    return res.sendStatus(200);
  }

  if (typeof path !== "string" || !path) {
    return res.sendStatus(401);
  }

  const [stream] = await db
    .select({ id: livestreaming.id })
    .from(livestreaming)
    .where(eq(livestreaming.streamKey, path))
    .limit(1);

  if (!stream) {
    // Logged because a rejected publish is otherwise invisible: OBS just says
    // the connection failed.
    console.warn(`[live] refused publish to unknown key "${path}"`);
    return res.sendStatus(401);
  }

  return res.sendStatus(200);
};

/** The creator's own streams, with the details OBS needs. */
const listMyStreams = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const rows = await db
    .select()
    .from(livestreaming)
    .where(eq(livestreaming.creatorId, viewer.id))
    .orderBy(desc(livestreaming.createdAt));

  return res.json({
    streams: rows.map((row) => ({
      ...row,
      // Only the owner ever sees these two.
      ingestUrl: RTMP_URL,
      playbackUrl: playbackUrlFor(row.streamKey),
    })),
  });
};

const createStream = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const { title, category, tags } = req.body ?? {};

  if (typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ message: "A title is required" });
  }

  if (title.trim().length > MAX_TITLE) {
    return res.status(400).json({ message: "That title is too long" });
  }

  const streamKey = newStreamKey();

  const [created] = await db
    .insert(livestreaming)
    .values({
      creatorId: viewer.id,
      title: title.trim(),
      category: typeof category === "string" ? category.trim() || null : null,
      tags: typeof tags === "string" ? tags.trim() || null : null,
      streamKey,
      playbackUrl: playbackUrlFor(streamKey),
    })
    .returning();

  return res.status(201).json({
    stream: { ...created, ingestUrl: RTMP_URL },
  });
};

const updateStream = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Stream id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({ id: livestreaming.id, creatorId: livestreaming.creatorId })
    .from(livestreaming)
    .where(eq(livestreaming.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Stream not found" });
  }

  if (existing.creatorId !== viewer.id) {
    return res.status(403).json({ message: "You can only edit your own streams" });
  }

  const { title, category, tags } = req.body ?? {};
  const patch: Partial<typeof livestreaming.$inferInsert> = {};

  if (typeof title === "string") {
    if (!title.trim()) {
      return res.status(400).json({ message: "Title cannot be empty" });
    }
    patch.title = title.trim();
  }

  if (typeof category === "string") patch.category = category.trim() || null;
  if (typeof tags === "string") patch.tags = tags.trim() || null;

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ message: "No supported fields to update" });
  }

  const [updated] = await db
    .update(livestreaming)
    .set(patch)
    .where(eq(livestreaming.id, id))
    .returning();

  return res.json({ stream: { ...updated, ingestUrl: RTMP_URL } });
};

/*

  Client
  |
  | POST /livestreams/:id/key
  v
A new key, so a leaked one stops working
  |
  v
Refused while live — rotating mid-broadcast would cut the stream

*/

const rotateKey = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Stream id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: livestreaming.id,
      creatorId: livestreaming.creatorId,
      status: livestreaming.status,
    })
    .from(livestreaming)
    .where(eq(livestreaming.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Stream not found" });
  }

  if (existing.creatorId !== viewer.id) {
    return res.status(403).json({ message: "You can only edit your own streams" });
  }

  if (existing.status === "live") {
    return res.status(409).json({
      message: "Stop the broadcast before rotating the key",
    });
  }

  const streamKey = newStreamKey();

  const [updated] = await db
    .update(livestreaming)
    .set({ streamKey, playbackUrl: playbackUrlFor(streamKey) })
    .where(eq(livestreaming.id, id))
    .returning();

  return res.json({ stream: { ...updated, ingestUrl: RTMP_URL } });
};

const deleteStream = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Stream id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({ id: livestreaming.id, creatorId: livestreaming.creatorId })
    .from(livestreaming)
    .where(eq(livestreaming.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Stream not found" });
  }

  if (existing.creatorId !== viewer.id) {
    return res.status(403).json({ message: "You can only delete your own streams" });
  }

  await db.delete(livestreaming).where(eq(livestreaming.id, id));

  return res.json({ id });
};

/** Everyone currently broadcasting. */
const listLive = async (_req: Request, res: Response) => {
  const rows = await db
    .select({
      id: livestreaming.id,
      title: livestreaming.title,
      category: livestreaming.category,
      status: livestreaming.status,
      viewCount: livestreaming.viewCount,
      updatedAt: livestreaming.updatedAt,
      creator: identityColumns,
    })
    .from(livestreaming)
    .innerJoin(user, eq(livestreaming.creatorId, user.id))
    .where(eq(livestreaming.status, "live"))
    .orderBy(desc(livestreaming.updatedAt));

  return res.json({
    streams: rows.map((row) => ({
      id: row.id,
      title: row.title,
      category: row.category,
      status: row.status,
      viewCount: row.viewCount,
      startedAt: row.updatedAt,
      creator: toPublicIdentity(row.creator),
    })),
  });
};

/** One stream, as a viewer sees it. The key is never included. */
const getStream = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Stream id is required" });
  }

  const [row] = await db
    .select({
      id: livestreaming.id,
      title: livestreaming.title,
      category: livestreaming.category,
      tags: livestreaming.tags,
      status: livestreaming.status,
      viewCount: livestreaming.viewCount,
      playbackUrl: livestreaming.playbackUrl,
      vodvideoUrl: livestreaming.vodvideoUrl,
      updatedAt: livestreaming.updatedAt,
      creatorId: livestreaming.creatorId,
      creator: identityColumns,
    })
    .from(livestreaming)
    .innerJoin(user, eq(livestreaming.creatorId, user.id))
    .where(eq(livestreaming.id, id))
    .limit(1);

  if (!row) {
    return res.status(404).json({ message: "Stream not found" });
  }

  const viewer = await currentUser(req);

  return res.json({
    stream: {
      id: row.id,
      title: row.title,
      category: row.category,
      tags: row.tags,
      status: row.status,
      viewCount: row.viewCount,
      // Only meaningful while live; offline it would 404 in the player.
      playbackUrl: row.status === "live" ? row.playbackUrl : null,
      vodvideoUrl: row.vodvideoUrl,
      startedAt: row.updatedAt,
      isSelf: viewer?.id === row.creatorId,
      creator: toPublicIdentity(row.creator),
    },
  });
};

/** Counted once per viewer session, the same way video views are. */
const recordStreamView = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Stream id is required" });
  }

  const [row] = await db
    .select({ id: livestreaming.id, status: livestreaming.status })
    .from(livestreaming)
    .where(eq(livestreaming.id, id))
    .limit(1);

  if (!row) {
    return res.status(404).json({ message: "Stream not found" });
  }

  if (row.status !== "live") {
    return res.status(409).json({ message: "That stream is not live" });
  }

  // Incremented in the database rather than read-modify-write, so concurrent
  // viewers cannot overwrite each other's count.
  const [updated] = await db
    .update(livestreaming)
    .set({ viewCount: sql`${livestreaming.viewCount} + 1` })
    .where(eq(livestreaming.id, id))
    .returning({ viewCount: livestreaming.viewCount });

  return res.json({ viewCount: updated?.viewCount ?? null });
};

export {
  authorizeStream,
  listMyStreams,
  createStream,
  updateStream,
  rotateKey,
  deleteStream,
  listLive,
  getStream,
  recordStreamView,
  playbackUrlFor,
};
