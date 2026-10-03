import type { Request, Response } from "express";
import { and, count, desc, eq, lt } from "drizzle-orm";
import { db } from "../db/db.js";
import { subscriber, user, video } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { toPublicIdentity } from "../lib/identity.js";
import { listingColumns, likeCounts, commentCounts } from "../lib/listing.js";

/*

  Client
  |
  | GET /creators/:id
  v
Creator + subscriber count + their published videos
  |
  +--> isSubscribed, when someone is signed in
  |
  v
JSON response

*/

const DEFAULT_PAGE_SIZE = 12;
const MAX_PAGE_SIZE = 50;

export const countSubscribers = async (creatorId: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(subscriber)
    .where(eq(subscriber.creatorId, creatorId));

  return row?.value ?? 0;
};

export const isSubscribedTo = async (
  creatorId: string,
  viewerId: string | null,
): Promise<boolean> => {
  if (!viewerId) return false;

  const [row] = await db
    .select({ id: subscriber.id })
    .from(subscriber)
    .where(
      and(eq(subscriber.creatorId, creatorId), eq(subscriber.userId, viewerId)),
    )
    .limit(1);

  return Boolean(row);
};

const loadCreator = async (creatorId: string) => {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      image: user.image,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      bio: user.bio,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, creatorId))
    .limit(1);

  if (!row) return null;

  // Channel identity wins over whatever the account was created with.
  return { ...toPublicIdentity(row), bio: row.bio, createdAt: row.createdAt };
};

const getCreator = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Creator id is required" });
  }

  const creator = await loadCreator(id);

  if (!creator) {
    return res.status(404).json({ message: "Creator not found" });
  }

  const viewer = await currentUser(req);

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;


  const visible = and(
    eq(video.creatorId, id),
    eq(video.isPublished, true),
    eq(video.status, "ready"),
  );

  const videos = await db
    .select(listingColumns)
    .from(video)
    .leftJoin(likeCounts, eq(likeCounts.videoId, video.id))
    .leftJoin(commentCounts, eq(commentCounts.videoId, video.id))
    .where(cursor ? and(visible, lt(video.id, cursor)) : visible)
    .orderBy(desc(video.id))
    .limit(limit);

  const [totals] = await db
    .select({ value: count() })
    .from(video)
    .where(visible);

  return res.json({
    creator: {
      ...creator,
      subscriberCount: await countSubscribers(id),
      videoCount: totals?.value ?? 0,
      isSubscribed: await isSubscribedTo(id, viewer?.id ?? null),
      isSelf: viewer?.id === id,
    },
    videos,
    meta: {
      nextCursor: videos.length === limit ? (videos.at(-1)?.id ?? null) : null,
      count: videos.length,
    },
  });
};

/*

  Client
  |
  | POST /creators/:id/subscribe     DELETE /creators/:id/subscribe
  v
Cannot subscribe to yourself
  |
  v
insert ... on conflict do nothing   |   delete
  |
  v
{ subscribed, subscriberCount }

*/

const subscribe = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Creator id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  if (viewer.id === id) {
    return res.status(400).json({ message: "You cannot subscribe to yourself" });
  }

  const creator = await loadCreator(id);

  if (!creator) {
    return res.status(404).json({ message: "Creator not found" });
  }


  await db
    .insert(subscriber)
    .values({ userId: viewer.id, creatorId: id })
    .onConflictDoNothing();

  return res.json({
    subscribed: true,
    subscriberCount: await countSubscribers(id),
  });
};

const unsubscribe = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Creator id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  await db
    .delete(subscriber)
    .where(
      and(eq(subscriber.creatorId, id), eq(subscriber.userId, viewer.id)),
    );

  return res.json({
    subscribed: false,
    subscriberCount: await countSubscribers(id),
  });
};

export { getCreator, subscribe, unsubscribe };
