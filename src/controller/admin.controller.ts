import type { Request, Response } from "express";
import { count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../db/db.js";
import { subscriber, user, video } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { toPublicIdentity } from "../lib/identity.js";

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

export { listUsers, setUserRole };
