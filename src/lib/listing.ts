import { count, eq, getTableColumns, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { comment, like, video } from "../db/Schema.js";

/**
 * Per-video engagement totals for a listing.
 *
 * Grouped subqueries joined once, rather than a correlated `(select count(*)
 * ... where video_id = id)` per column: inside such a subquery drizzle renders
 * the outer column unqualified, so `id` binds to the *child* table's own
 * primary key and every count silently comes back zero.
 *
 * The aliases also carry distinct column names — two `total`s across two joins
 * would be ambiguous in the outer select.
 */
export const likeCounts = db
  .select({ videoId: like.videoId, likeTotal: count().as("like_total") })
  .from(like)
  .groupBy(like.videoId)
  .as("like_counts");

export const commentCounts = db
  .select({ videoId: comment.videoId, commentTotal: count().as("comment_total") })
  .from(comment)
  .groupBy(comment.videoId)
  .as("comment_counts");

/** Every video column plus its counts. A video with none joins to null. */
export const listingColumns = {
  ...getTableColumns(video),
  likeCount: sql<number>`coalesce(${likeCounts.likeTotal}, 0)::int`,
  commentCount: sql<number>`coalesce(${commentCounts.commentTotal}, 0)::int`,
};

/** The two joins `listingColumns` depends on, applied in one place. */
export const joinEngagementCounts = <
  T extends {
    leftJoin: (table: typeof likeCounts | typeof commentCounts, on: unknown) => T;
  },
>(
  query: T,
): T =>
  query
    .leftJoin(likeCounts, eq(likeCounts.videoId, video.id))
    .leftJoin(commentCounts, eq(commentCounts.videoId, video.id));
