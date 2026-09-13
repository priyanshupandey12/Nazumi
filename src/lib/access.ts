import type { Request } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq } from "drizzle-orm";
import { auth } from "./auth.js";
import { db } from "../db/db.js";
import { video } from "../db/Schema.js";

/**
 * The signed-in user, or null. Separate from a "require auth" helper because
 * several engagement reads are public but answer differently once we know who
 * is asking — `isLiked` and `isSubscribed` only mean something for a viewer.
 */
export const currentUser = async (req: Request) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  return session?.user ?? null;
};

export type VisibleVideo = {
  id: string;
  creatorId: string;
  isPublished: boolean;
  status: "processing" | "ready" | "failed";
};

/**
 * Loads a video only if `viewerId` is allowed to see it: published and ready
 * for everyone, anything at all for its own creator.
 *
 * Returns null rather than throwing so callers can answer 404 for "does not
 * exist" and "not yours" alike — telling them apart leaks which drafts exist.
 */
export const loadVisibleVideo = async (
  videoId: string,
  viewerId: string | null,
): Promise<VisibleVideo | null> => {
  const [row] = await db
    .select({
      id: video.id,
      creatorId: video.creatorId,
      isPublished: video.isPublished,
      status: video.status,
    })
    .from(video)
    .where(eq(video.id, videoId))
    .limit(1);

  if (!row) return null;

  if (row.isPublished && row.status === "ready") return row;

  return viewerId && row.creatorId === viewerId ? row : null;
};

/** A video anyone may engage with — drafts accept no likes or comments. */
export const loadPublicVideo = async (videoId: string) => {
  const [row] = await db
    .select({ id: video.id, creatorId: video.creatorId })
    .from(video)
    .where(
      and(
        eq(video.id, videoId),
        eq(video.isPublished, true),
        eq(video.status, "ready"),
      ),
    )
    .limit(1);

  return row ?? null;
};
