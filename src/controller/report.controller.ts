import type { Request, Response } from "express";
import { and, desc, eq, isNotNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/db.js";
import { comment, report, user, video } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { notifyTakedown } from "../lib/notify.js";
import { resolveIdentity } from "../lib/identity.js";

/*

  Client
  |
  | POST /reports  { videoId | commentId, reason, details? }
  v
Target must exist and be visible
  |
  v
One report per person per target
  |
  v
Queue: the video's creator for comments on their videos,
       an admin for everything

*/

const REASONS = [
  "spam",
  "harassment",
  "sexual",
  "violence",
  "misinformation",
  "other",
] as const;

type Reason = (typeof REASONS)[number];

const MAX_DETAILS = 500;
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

const isReason = (value: unknown): value is Reason =>
  typeof value === "string" && (REASONS as readonly string[]).includes(value);

const createReport = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const { videoId, commentId, reason, details } = req.body ?? {};

  if (!isReason(reason)) {
    return res.status(400).json({ message: "Pick a reason for the report" });
  }

  const hasVideo = typeof videoId === "string" && videoId;
  const hasComment = typeof commentId === "string" && commentId;

  // Exactly one target, so a row always has a single thing to point at.
  if (Boolean(hasVideo) === Boolean(hasComment)) {
    return res
      .status(400)
      .json({ message: "Report either a video or a comment, not both" });
  }

  if (typeof details === "string" && details.trim().length > MAX_DETAILS) {
    return res
      .status(400)
      .json({ message: `Details can be at most ${MAX_DETAILS} characters` });
  }

  if (hasVideo) {
    const [target] = await db
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

    if (!target) {
      return res.status(404).json({ message: "Video not found" });
    }

    if (target.creatorId === viewer.id) {
      return res.status(400).json({ message: "You cannot report your own video" });
    }
  } else {
    const [target] = await db
      .select({ id: comment.id, authorId: comment.userId })
      .from(comment)
      .where(eq(comment.id, commentId))
      .limit(1);

    if (!target) {
      return res.status(404).json({ message: "Comment not found" });
    }

    if (target.authorId === viewer.id) {
      return res.status(400).json({ message: "You cannot report your own comment" });
    }
  }

  // The unique index makes a second report a no-op rather than an error the
  // reporter has to understand.
  await db
    .insert(report)
    .values({
      reporterId: viewer.id,
      videoId: hasVideo ? videoId : null,
      commentId: hasComment ? commentId : null,
      reason,
      details: typeof details === "string" ? details.trim() || null : null,
    })
    .onConflictDoNothing();

  return res.status(201).json({ message: "Thanks. We will take a look." });
};

/*

  Client
  |
  | GET /reports
  v
Creators see reports on comments under their own videos.
Admins see everything, including reports about videos.

*/

const listReports = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [account] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, viewer.id))
    .limit(1);

  const isAdmin = account?.role === "admin";

  const limit = Math.min(
    parseInt(req.query.limit as string) || DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  const cursor = typeof req.query.cursor === "string" ? req.query.cursor : null;
  const status = typeof req.query.status === "string" ? req.query.status : "open";

  const scope = isAdmin
    ? // Everything.
      sql`true`
    : // A creator moderates the comments under their own videos. Reports about
      // a video itself are not theirs to judge.
      and(
        isNotNull(report.commentId),
        eq(video.creatorId, viewer.id),
      )!;

  const statusFilter =
    status === "all"
      ? sql`true`
      : eq(report.status, status as "open" | "dismissed" | "actioned");

  const where = and(
    scope,
    statusFilter,
    cursor ? lt(report.id, cursor) : undefined,
  );

  const rows = await db
    .select({
      id: report.id,
      reason: report.reason,
      details: report.details,
      status: report.status,
      createdAt: report.createdAt,
      reporterId: user.id,
      reporterName: user.name,
      reporterImage: user.image,
      reporterDisplayName: user.displayName,
      reporterAvatarUrl: user.avatarUrl,
      commentId: comment.id,
      commentMessage: comment.message,
      videoId: video.id,
      videoTitle: video.title,
    })
    .from(report)
    .innerJoin(user, eq(report.reporterId, user.id))
    .leftJoin(comment, eq(report.commentId, comment.id))
    // A comment report reaches its video through the comment; a video report
    // points at one directly.
    .leftJoin(
      video,
      or(eq(report.videoId, video.id), eq(comment.videoId, video.id)),
    )
    .where(where)
    .orderBy(desc(report.id))
    .limit(limit);

  return res.json({
    reports: rows.map((row) => ({
      id: row.id,
      reason: row.reason,
      details: row.details,
      status: row.status,
      createdAt: row.createdAt,
      reporter: resolveIdentity({
        id: row.reporterId,
        name: row.reporterName,
        image: row.reporterImage,
        displayName: row.reporterDisplayName,
        avatarUrl: row.reporterAvatarUrl,
      }),
      comment: row.commentId
        ? { id: row.commentId, message: row.commentMessage }
        : null,
      video: row.videoId ? { id: row.videoId, title: row.videoTitle } : null,
    })),
    isAdmin,
    meta: {
      nextCursor: rows.length === limit ? (rows.at(-1)?.id ?? null) : null,
      count: rows.length,
    },
  });
};

/*

  Client
  |
  | POST /reports/:id/resolve  { action: "dismiss" | "delete" }
  v
Only a moderator of that target
  |
  +---- "delete" removes the comment, which cascades its reports away
  |
  v
{ status }

*/

const resolveReport = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Report id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const { action } = req.body ?? {};

  if (action !== "dismiss" && action !== "delete" && action !== "takedown") {
    return res
      .status(400)
      .json({ message: "Action must be dismiss, delete or takedown" });
  }

  const [existing] = await db
    .select({
      id: report.id,
      commentId: report.commentId,
      videoId: report.videoId,
      commentVideoCreatorId: video.creatorId,
    })
    .from(report)
    .leftJoin(comment, eq(report.commentId, comment.id))
    .leftJoin(video, eq(comment.videoId, video.id))
    .where(eq(report.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Report not found" });
  }

  const [account] = await db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, viewer.id))
    .limit(1);

  const isAdmin = account?.role === "admin";
  const ownsTarget = existing.commentVideoCreatorId === viewer.id;

  if (!isAdmin && !ownsTarget) {
    return res.status(403).json({ message: "That is not yours to moderate" });
  }

  // Taking a video down is an admin decision: judging a complaint about your
  // own video was never the creator's call.
  if (existing.videoId && !isAdmin) {
    return res
      .status(403)
      .json({ message: "Only an admin can act on a report about a video" });
  }

  if (action === "takedown") {
    if (!existing.videoId) {
      return res
        .status(400)
        .json({ message: "Only a reported video can be taken down" });
    }

    const { reason } = req.body ?? {};
    const text =
      typeof reason === "string" && reason.trim()
        ? reason.trim()
        : "Removed after a report";

    const [taken] = await db
      .update(video)
      .set({ isPublished: false, takedownReason: text, takedownAt: new Date() })
      .where(eq(video.id, existing.videoId))
      .returning({ creatorId: video.creatorId });

    if (!taken) {
      return res.status(404).json({ message: "Video not found" });
    }

    console.warn(
      `[moderation] admin ${viewer.id} took down video ${existing.videoId} from report ${id}: ${text}`,
    );

    await notifyTakedown({
      creatorId: taken.creatorId,
      videoId: existing.videoId,
    });

    await db
      .update(report)
      .set({ status: "actioned", reviewedAt: new Date() })
      .where(eq(report.id, id));

    return res.json({ status: "actioned" });
  }

  if (action === "delete") {
    if (existing.videoId) {
      // Permanent removal, for content that must not simply be hidden.
      console.warn(
        `[moderation] admin ${viewer.id} deleted video ${existing.videoId} from report ${id}`,
      );
      await db.delete(video).where(eq(video.id, existing.videoId));
      return res.json({ status: "actioned" });
    }

    if (!existing.commentId) {
      return res.status(400).json({ message: "That report has no target" });
    }

    // Reports on this comment cascade away with it, this one included.
    await db.delete(comment).where(eq(comment.id, existing.commentId));
    return res.json({ status: "actioned" });
  }

  await db
    .update(report)
    .set({ status: "dismissed", reviewedAt: new Date() })
    .where(eq(report.id, id));

  return res.json({ status: "dismissed" });
};

/** The badge on the moderation link. */
const openReportCount = async (req: Request, res: Response) => {
  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const mine = await db
    .select({ id: report.id })
    .from(report)
    .innerJoin(comment, eq(report.commentId, comment.id))
    .innerJoin(video, eq(comment.videoId, video.id))
    .where(and(eq(video.creatorId, viewer.id), eq(report.status, "open")));

  return res.json({ openCount: mine.length });
};

export { createReport, listReports, resolveReport, openReportCount, REASONS };
