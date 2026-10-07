import type { Request, Response } from "express";
import { and, count, desc, eq, ilike, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { report, subscriber, user, video } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { identityColumns, toPublicIdentity } from "../lib/identity.js";
import { notifyTakedown } from "../lib/notify.js";

/*

  Client
  |
  | GET /admin/users?q=
  v
Admin only
  |
  v
{ users: [{ ...identity, role, videoCount, subscriberCount }] }

*/

/**
 * Totals per account, as grouped subqueries joined once.
 *
 * Not correlated `(select count(*) ... where creator_id = id)` subqueries:
 * inside a `select()` drizzle renders the outer column unqualified, so `id`
 * binds to the child table's own primary key. Here that compares a text user
 * id to a uuid and the query fails outright; in a listing it silently returns
 * zero. Same reasoning as src/lib/listing.ts.
 */
const videoCounts = db
  .select({ creatorId: video.creatorId, videoTotal: count().as("video_total") })
  .from(video)
  .groupBy(video.creatorId)
  .as("video_counts");

const subscriberCounts = db
  .select({
    creatorId: subscriber.creatorId,
    subscriberTotal: count().as("subscriber_total"),
  })
  .from(subscriber)
  .groupBy(subscriber.creatorId)
  .as("subscriber_counts");

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

/**
 * The first admin cannot be made through this API — there is nobody to grant
 * it. It is set directly against the database, which is deliberately the only
 * way in:
 *
 *   update "user" set role = 'admin' where email = 'you@example.com';
 *
 * Every grant after that happens in the app, by an existing admin.
 */

/**
 * Resolves the caller and refuses anyone who is not an admin.
 *
 * Reads the role from the database rather than the session: a role revoked a
 * moment ago must take effect on the next request, not whenever the session
 * happens to be reissued.
 */
const requireAdmin = async (req: Request) => {
  const viewer = await currentUser(req);
  if (!viewer) return { error: 401 as const };

  const [account] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, viewer.id))
    .limit(1);

  if (account?.role !== "admin") return { error: 403 as const };

  return { viewer };
};

const deny = (res: Response, error: 401 | 403) =>
  error === 401
    ? res.status(401).json({ message: "Unauthorized - Please sign in first" })
    : res.status(403).json({ message: "Admins only" });

const listUsers = async (req: Request, res: Response) => {
  const auth = await requireAdmin(req);
  if (auth.error) return deny(res, auth.error);

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  const search = q
    ? or(
        ilike(user.name, `%${q}%`),
        ilike(user.email, `%${q}%`),
        ilike(user.displayName, `%${q}%`),
      )
    : undefined;

  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      role: user.role,
      createdAt: user.createdAt,
      videoCount: videoCounts.videoTotal,
      subscriberCount: subscriberCounts.subscriberTotal,
    })
    .from(user)
    .leftJoin(videoCounts, eq(videoCounts.creatorId, user.id))
    .leftJoin(subscriberCounts, eq(subscriberCounts.creatorId, user.id))
    .where(search)
    .orderBy(desc(user.createdAt))
    .limit(limit);

  const [total] = await db.select({ value: count() }).from(user);

  return res.json({
    users: rows.map((row) => ({
      ...toPublicIdentity(row),
      email: row.email,
      role: row.role ?? "user",
      videoCount: row.videoCount ?? 0,
      subscriberCount: row.subscriberCount ?? 0,
      createdAt: row.createdAt,
    })),
    total: total?.value ?? 0,
  });
};

/*

  Client
  |
  | PATCH /admin/users/:id/role  { role: "user" | "admin" }
  v
Admin only, and never your own account
  |
  v
{ id, role }

*/

const setUserRole = async (req: Request, res: Response) => {
  const auth = await requireAdmin(req);
  if (auth.error) return deny(res, auth.error);

  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "User id is required" });
  }

  const { role } = req.body ?? {};

  if (role !== "user" && role !== "admin") {
    return res.status(400).json({ message: "Role must be user or admin" });
  }

  // Changing your own role is refused outright. Demoting yourself when you are
  // the only admin locks everyone out of moderation with no way back except
  // the database.
  if (id === auth.viewer.id) {
    return res
      .status(400)
      .json({ message: "You cannot change your own role" });
  }

  const [updated] = await db
    .update(user)
    .set({ role })
    .where(eq(user.id, id))
    .returning({ id: user.id, role: user.role });

  if (!updated) {
    return res.status(404).json({ message: "User not found" });
  }

  return res.json({ id: updated.id, role: updated.role });
};

/*

  Admin
  |
  | GET /admin/videos?q=&filter=reported|takendown
  v
Everything on the platform, not just what has been reported
  |
  v
POST /admin/videos/:id/takedown  { reason }   -> unpublished, creator told
POST /admin/videos/:id/restore                -> the decision reversed

*/

const reportCounts = db
  .select({ videoId: report.videoId, reportTotal: count().as("report_total") })
  .from(report)
  .where(isNotNull(report.videoId))
  .groupBy(report.videoId)
  .as("report_counts");

const MAX_TAKEDOWN_REASON = 300;

const listAllVideos = async (req: Request, res: Response) => {
  const auth = await requireAdmin(req);
  if (auth.error) return deny(res, auth.error);

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const filter = typeof req.query.filter === "string" ? req.query.filter : "";

  const clauses = [];

  if (q) {
    clauses.push(
      or(
        ilike(video.title, `%${q}%`),
        ilike(video.description, `%${q}%`),
        ilike(user.name, `%${q}%`),
        ilike(user.email, `%${q}%`),
      ),
    );
  }

  // Reviewing is usually triggered by something, so the common cases are
  // reachable without typing a query.
  if (filter === "takendown") clauses.push(isNotNull(video.takedownReason));
  if (filter === "reported") clauses.push(isNotNull(reportCounts.videoId));

  const rows = await db
    .select({
      id: video.id,
      title: video.title,
      description: video.description,
      thumbnailUrl: video.thumbnailUrl,
      status: video.status,
      isPublished: video.isPublished,
      category: video.category,
      viewCount: video.viewCount,
      createdAt: video.createdAt,
      takedownReason: video.takedownReason,
      takedownAt: video.takedownAt,
      creator: identityColumns,
      reportCount: reportCounts.reportTotal,
    })
    .from(video)
    .innerJoin(user, eq(video.creatorId, user.id))
    .leftJoin(reportCounts, eq(reportCounts.videoId, video.id))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(desc(video.createdAt))
    .limit(limit);

  return res.json({
    videos: rows.map((row) => ({
      id: row.id,
      title: row.title,
      description: row.description,
      thumbnailUrl: row.thumbnailUrl,
      status: row.status,
      isPublished: row.isPublished,
      category: row.category,
      viewCount: row.viewCount,
      createdAt: row.createdAt,
      takedownReason: row.takedownReason,
      takedownAt: row.takedownAt,
      reportCount: row.reportCount ?? 0,
      creator: toPublicIdentity(row.creator),
    })),
  });
};

const takedownVideo = async (req: Request, res: Response) => {
  const auth = await requireAdmin(req);
  if (auth.error) return deny(res, auth.error);

  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const { reason } = req.body ?? {};

  // A takedown with no stated reason is indistinguishable from a bug, both to
  // the creator and to whoever reviews the decision later.
  if (typeof reason !== "string" || !reason.trim()) {
    return res.status(400).json({ message: "A reason is required" });
  }

  if (reason.trim().length > MAX_TAKEDOWN_REASON) {
    return res.status(400).json({ message: "That reason is too long" });
  }

  const [updated] = await db
    .update(video)
    .set({
      isPublished: false,
      takedownReason: reason.trim(),
      takedownAt: new Date(),
    })
    .where(eq(video.id, id))
    .returning({ id: video.id, creatorId: video.creatorId, title: video.title });

  if (!updated) {
    return res.status(404).json({ message: "Video not found" });
  }

  console.warn(
    `[moderation] admin ${auth.viewer.id} took down "${updated.title}" (${id}): ${reason.trim()}`,
  );

  await notifyTakedown({ creatorId: updated.creatorId, videoId: id });

  return res.json({ id, takedownReason: reason.trim() });
};

const restoreVideo = async (req: Request, res: Response) => {
  const auth = await requireAdmin(req);
  if (auth.error) return deny(res, auth.error);

  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  // Clears the block but does not republish: whether it goes back up is the
  // creator's call, not the moderator's.
  const [updated] = await db
    .update(video)
    .set({ takedownReason: null, takedownAt: null })
    .where(eq(video.id, id))
    .returning({ id: video.id });

  if (!updated) {
    return res.status(404).json({ message: "Video not found" });
  }

  console.warn(`[moderation] admin ${auth.viewer.id} restored video ${id}`);

  return res.json({ id });
};

export { listUsers, setUserRole, listAllVideos, takedownVideo, restoreVideo };
