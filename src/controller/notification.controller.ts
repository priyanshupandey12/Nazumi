import type { Request, Response } from "express";
import { and, count, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "../db/db.js";
import { comment, notification, user, video } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { resolveIdentity } from "../lib/identity.js";

/*

  Client
  |
  | GET /notifications
  v
Recipient's own rows only
  |
  +--> actor, video and comment joined in
  |
  v
{ notifications, unreadCount, meta }

*/

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

export const unreadCountFor = async (userId: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(notification)
    .where(and(eq(notification.userId, userId), eq(notification.isRead, false)));

  return row?.value ?? 0;
};

const listNotifications = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;

  const mine = eq(notification.userId, viewer.id);

  // Left joins throughout: a notification outlives the account that caused it,
  // and should still read sensibly once the actor is gone.
  const rows = await db
    .select({
      id: notification.id,
      type: notification.type,
      isRead: notification.isRead,
      createdAt: notification.createdAt,
      actorId: user.id,
      actorName: user.name,
      actorImage: user.image,
      actorDisplayName: user.displayName,
      actorAvatarUrl: user.avatarUrl,
      videoId: video.id,
      videoTitle: video.title,
      videoThumbnailUrl: video.thumbnailUrl,
      commentId: comment.id,
      commentMessage: comment.message,
    })
    .from(notification)
    .leftJoin(user, eq(notification.actorId, user.id))
    .leftJoin(video, eq(notification.videoId, video.id))
    .leftJoin(comment, eq(notification.commentId, comment.id))
    .where(cursor ? and(mine, lt(notification.id, cursor)) : mine)
    .orderBy(desc(notification.id))
    .limit(limit);

  return res.json({
    notifications: rows.map((row) => ({
      id: row.id,
      type: row.type,
      isRead: row.isRead,
      createdAt: row.createdAt,
      actor: row.actorId
        ? resolveIdentity({
            id: row.actorId,
            name: row.actorName,
            image: row.actorImage,
            displayName: row.actorDisplayName,
            avatarUrl: row.actorAvatarUrl,
          })
        : null,
      video: row.videoId
        ? {
            id: row.videoId,
            title: row.videoTitle,
            thumbnailUrl: row.videoThumbnailUrl,
          }
        : null,
      comment: row.commentId
        ? { id: row.commentId, message: row.commentMessage }
        : null,
    })),
    unreadCount: await unreadCountFor(viewer.id),
    meta: {
      nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      count: rows.length,
    },
  });
};

/** The bell polls this, so it stays a single indexed count. */
const getUnreadCount = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  return res.json({ unreadCount: await unreadCountFor(viewer.id) });
};

/*

  Client
  |
  | POST /notifications/read   { ids?: string[] }
  v
Own rows only — ids belonging to someone else are simply not matched
  |
  v
{ unreadCount }

*/

const markRead = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const { ids } = req.body ?? {};
  const mine = eq(notification.userId, viewer.id);

  // Scoping every update to the viewer means a forged id cannot touch anyone
  // else's rows; it just matches nothing.
  if (Array.isArray(ids)) {
    const wanted = ids.filter((id): id is string => typeof id === "string");
    if (wanted.length > 0) {
      await db
        .update(notification)
        .set({ isRead: true })
        .where(and(mine, inArray(notification.id, wanted)));
    }
  } else {
    await db.update(notification).set({ isRead: true }).where(mine);
  }

  return res.json({ unreadCount: await unreadCountFor(viewer.id) });
};

export { listNotifications, getUnreadCount, markRead };
