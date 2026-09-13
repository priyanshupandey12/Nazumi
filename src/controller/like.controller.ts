import type { Request, Response } from "express";
import { and, count, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { like } from "../db/Schema.js";
import { currentUser, loadVisibleVideo } from "../lib/access.js";

/*

  Client
  |
  | POST /videos/:id/like        DELETE /videos/:id/like
  v
Visibility check (a draft nobody can see takes no likes)
  |
  v
insert ... on conflict do nothing   |   delete
  |
  v
{ liked, likeCount }

*/

const countLikes = async (videoId: string): Promise<number> => {
  const [row] = await db
    .select({ value: count() })
    .from(like)
    .where(eq(like.videoId, videoId));

  return row?.value ?? 0;
};

const likeVideo = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const user = await currentUser(req);

  if (!user) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const target = await loadVisibleVideo(id, user.id);

  if (!target) {
    return res.status(404).json({ message: "Video not found" });
  }


  await db
    .insert(like)
    .values({ userId: user.id, videoId: id })
    .onConflictDoNothing();

  return res.json({ liked: true, likeCount: await countLikes(id) });
};

const unlikeVideo = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const user = await currentUser(req);

  if (!user) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  await db
    .delete(like)
    .where(and(eq(like.videoId, id), eq(like.userId, user.id)));

  return res.json({ liked: false, likeCount: await countLikes(id) });
};


export const hasLiked = async (
  videoId: string,
  viewerId: string | null,
): Promise<boolean> => {
  if (!viewerId) return false;

  const [row] = await db
    .select({ id: like.id })
    .from(like)
    .where(and(eq(like.videoId, videoId), eq(like.userId, viewerId)))
    .limit(1);

  return Boolean(row);
};

export { likeVideo, unlikeVideo, countLikes };
