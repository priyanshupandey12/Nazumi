import type { Request, Response } from "express";
import { and, asc, count, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../db/db.js";
import { comment, user, video } from "../db/Schema.js";
import { currentUser, loadVisibleVideo } from "../lib/access.js";
import { notifyComment } from "../lib/notify.js";
import { resolveIdentity } from "../lib/identity.js";

/*

  Client
  |
  | GET /videos/:id/comments
  v
Visibility check
  |
  +--> top-level comments (cursor paginated, newest first)
  |
  +--> every reply to that page, in one query
  |
  v
{ comments: [ { ...comment, replies: [...] } ], nextCursor }

*/

const MAX_MESSAGE_LENGTH = 2_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;


const commentFields = {
  id: comment.id,
  message: comment.message,
  createdAt: comment.createdAt,
  parentCommentId: comment.parentCommentId,
  authorId: user.id,
  authorName: user.name,
  authorImage: user.image,
  authorDisplayName: user.displayName,
  authorAvatarUrl: user.avatarUrl,
};

type CommentRow = {
  id: string;
  message: string;
  createdAt: Date;
  parentCommentId: string | null;
  authorId: string;
  authorName: string;
  authorImage: string | null;
  authorDisplayName: string | null;
  authorAvatarUrl: string | null;
};

/** The poster's own identity, so a fresh comment matches the rest of the list. */
const authorIdentity = async (
  id: string,
  fallbackName: string,
  fallbackImage: string | null,
) => {
  const [row] = await db
    .select({ displayName: user.displayName, avatarUrl: user.avatarUrl })
    .from(user)
    .where(eq(user.id, id))
    .limit(1);

  return resolveIdentity({
    id,
    name: fallbackName,
    image: fallbackImage,
    displayName: row?.displayName ?? null,
    avatarUrl: row?.avatarUrl ?? null,
  });
};

const shape = (row: CommentRow) => ({
  id: row.id,
  message: row.message,
  createdAt: row.createdAt,
  parentCommentId: row.parentCommentId,
  author: resolveIdentity({
    id: row.authorId,
    name: row.authorName,
    image: row.authorImage,
    displayName: row.authorDisplayName,
    avatarUrl: row.authorAvatarUrl,
  }),
});

export const countComments = async (videoId: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(comment)
    .where(eq(comment.videoId, videoId));

  return row?.value ?? 0;
};

const listComments = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }


  const viewer = await currentUser(req);
  const target = await loadVisibleVideo(id, viewer?.id ?? null);

  if (!target) {
    return res.status(404).json({ message: "Video not found" });
  }

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;


  const topLevel = and(eq(comment.videoId, id), isNull(comment.parentCommentId));

  const parents: CommentRow[] = await db
    .select(commentFields)
    .from(comment)
    .innerJoin(user, eq(comment.userId, user.id))
    .where(cursor ? and(topLevel, lt(comment.id, cursor)) : topLevel)
    .orderBy(desc(comment.id))
    .limit(limit);


  const replies: CommentRow[] = parents.length
    ? await db
        .select(commentFields)
        .from(comment)
        .innerJoin(user, eq(comment.userId, user.id))
        .where(
          inArray(
            comment.parentCommentId,
            parents.map((row) => row.id),
          ),
        )
        .orderBy(asc(comment.id))
    : [];

  const byParent = new Map<string, ReturnType<typeof shape>[]>();
  for (const reply of replies) {
    const key = reply.parentCommentId;
    if (!key) continue;
    const bucket = byParent.get(key);
    if (bucket) bucket.push(shape(reply));
    else byParent.set(key, [shape(reply)]);
  }

  return res.json({
    comments: parents.map((row) => ({
      ...shape(row),
      replies: byParent.get(row.id) ?? [],
    })),
    meta: {
   
      nextCursor: parents.length === limit ? (parents.at(-1)?.id ?? null) : null,
      count: parents.length,
    },
  });
};

const createComment = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const target = await loadVisibleVideo(id, viewer.id);

  if (!target) {
    return res.status(404).json({ message: "Video not found" });
  }

  const { message, parentCommentId } = req.body ?? {};

  if (typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ message: "A comment cannot be empty" });
  }

  if (message.trim().length > MAX_MESSAGE_LENGTH) {
    return res
      .status(400)
      .json({ message: `Comments are limited to ${MAX_MESSAGE_LENGTH} characters` });
  }

  let parentId: string | null = null;

  if (typeof parentCommentId === "string" && parentCommentId) {
    const [parent] = await db
      .select({
        id: comment.id,
        videoId: comment.videoId,
        parentCommentId: comment.parentCommentId,
      })
      .from(comment)
      .where(eq(comment.id, parentCommentId))
      .limit(1);

    if (!parent || parent.videoId !== id) {
      return res.status(404).json({ message: "That comment no longer exists" });
    }

 
    parentId = parent.parentCommentId ?? parent.id;
  }

  const [created] = await db
    .insert(comment)
    .values({
      videoId: id,
      userId: viewer.id,
      message: message.trim(),
      parentCommentId: parentId,
    })
    .returning({ id: comment.id, createdAt: comment.createdAt });

  if (!created) {
    return res.status(500).json({ message: "Could not post that comment" });
  }

  let parentAuthorId: string | null = null;
  if (parentId) {
    const [parentAuthor] = await db
      .select({ userId: comment.userId })
      .from(comment)
      .where(eq(comment.id, parentId))
      .limit(1);
    parentAuthorId = parentAuthor?.userId ?? null;
  }

  await notifyComment({
    actorId: viewer.id,
    videoId: id,
    videoCreatorId: target.creatorId,
    commentId: created.id,
    parentAuthorId,
  });

  return res.status(201).json({
    comment: {
      id: created.id,
      message: message.trim(),
      createdAt: created.createdAt,
      parentCommentId: parentId,
      author: await authorIdentity(viewer.id, viewer.name, viewer.image ?? null),
      replies: [],
    },
  });
};

/*

  Client
  |
  | DELETE /comments/:id
  v
Author or the video's creator
  |
  v
Deleted (replies cascade)

*/

const deleteComment = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Comment id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: comment.id,
      authorId: comment.userId,
      creatorId: video.creatorId,
    })
    .from(comment)
    .innerJoin(video, eq(comment.videoId, video.id))
    .where(eq(comment.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Comment not found" });
  }


  const allowed =
    existing.authorId === viewer.id || existing.creatorId === viewer.id;

  if (!allowed) {
    return res.status(403).json({ message: "You can only delete your own comments" });
  }


  await db.delete(comment).where(eq(comment.id, id));

  return res.json({ id });
};

export { listComments, createComment, deleteComment };
