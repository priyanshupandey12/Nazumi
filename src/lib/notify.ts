import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { notification, subscriber } from "../db/Schema.js";

/**
 * Who gets told about what.
 *
 * Every rule lives here rather than in the controllers, so the answer to "why
 * did I get this?" is in one file. Notifications are never allowed to fail the
 * action that caused them: a comment that posted must stay posted even if the
 * notification write fails.
 */

const BATCH = 500;

const swallow = (label: string) => (error: unknown) => {
  console.error(`[notify] ${label} failed:`, error);
};

/**
 * A creator published something. Fans out to every subscriber.
 *
 * Called only when a video goes public for the first time — see `publishedAt`
 * on the video table — so republishing cannot notify the same people twice.
 */
export const notifyNewVideo = async (params: {
  creatorId: string;
  videoId: string;
}) => {
  const followers = await db
    .select({ userId: subscriber.userId })
    .from(subscriber)
    .where(eq(subscriber.creatorId, params.creatorId));

  if (followers.length === 0) return;

  const rows = followers.map((follower) => ({
    userId: follower.userId,
    actorId: params.creatorId,
    type: "new_video" as const,
    videoId: params.videoId,
  }));

  // Chunked so a creator with a large audience does not build one enormous
  // statement.
  for (let i = 0; i < rows.length; i += BATCH) {
    await db
      .insert(notification)
      .values(rows.slice(i, i + BATCH))
      .catch(swallow("new video fan-out"));
  }
};

/**
 * Someone commented. A top-level comment tells the video's creator; a reply
 * tells the author of the comment being replied to.
 *
 * Only one person is told per comment, which keeps a reply on your own video
 * from arriving twice.
 */
export const notifyComment = async (params: {
  actorId: string;
  videoId: string;
  videoCreatorId: string;
  commentId: string;
  parentAuthorId: string | null;
}) => {
  const recipient = params.parentAuthorId ?? params.videoCreatorId;

  // Nobody needs telling about their own comment.
  if (recipient === params.actorId) return;

  await db
    .insert(notification)
    .values({
      userId: recipient,
      actorId: params.actorId,
      type: params.parentAuthorId ? "reply" : "comment",
      videoId: params.videoId,
      commentId: params.commentId,
    })
    .catch(swallow("comment notification"));
};

/**
 * A transcode settled. Tells the creator, because nothing else does.
 *
 * The upload dialog polls while it is open, but a creator who closes the tab
 * has no way to learn the outcome — and a video that is ready but unpublished
 * is invisible until they notice.
 */
export const notifyTranscodeFinished = async (params: {
  creatorId: string;
  videoId: string;
  outcome: "ready" | "failed";
}) => {
  await db
    .insert(notification)
    .values({
      userId: params.creatorId,
      // No actor: the system did this, not a person.
      actorId: null,
      type: params.outcome === "ready" ? "video_ready" : "video_failed",
      videoId: params.videoId,
    })
    .catch(swallow(`transcode ${params.outcome} notification`));
};

/**
 * An admin removed a video from public view.
 *
 * The creator has to be told, with the reason — a video that silently
 * disappears from their own channel reads as a bug, and they would simply try
 * to publish it again.
 */
export const notifyTakedown = async (params: {
  creatorId: string;
  videoId: string;
}) => {
  await db
    .insert(notification)
    .values({
      userId: params.creatorId,
      // A moderation decision speaks for the platform, not for the admin who
      // made it — naming them invites retaliation.
      actorId: null,
      type: "video_takedown",
      videoId: params.videoId,
    })
    .catch(swallow("takedown notification"));
};
