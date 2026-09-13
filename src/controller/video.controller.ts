import path from "node:path";
import { rm } from "node:fs/promises";
import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, eq ,lt , desc, sql, inArray} from "drizzle-orm";
import { auth } from "../lib/auth.js";
import { db } from "../db/db.js";
import { subscriber, user, video, videoRendition } from "../db/Schema.js";
import { currentUser } from "../lib/access.js";
import { countLikes, hasLiked } from "./like.controller.js";
import { countComments } from "./comment.controller.js";
import { countSubscribers, isSubscribedTo } from "./creator.controller.js";
import {
  uploadToCloudinary,
  deleteFromCloudinary,
  deleteRawFolderFromCloudinary,
  publicIdFromUrl,
} from "../utils/cloudinary.js";
import {
  enqueueVideoProcessing,
  getVideoJobSnapshot,
  removeVideoJob,
} from "../queue/video.queue.js";
export type Video = typeof video.$inferSelect;
/*
Client
  |
  | POST /videos
  v
Express Controller
  |
  +---- Authentication
  |
  +---- Thumbnail -> Cloudinary
  |
  +---- Video metadata -> Database
  |
  +---- Processing job -> Queue
             |
             v
        Background Worker
             |
             v
        Transcoding
             |
             v
          Database

*/

const uploadVideo = async (req: Request, res: Response) => {
  const { title, description, thumbnailUrl, category, tags } = req.body ?? {};

  if (!req.file) {
    return res.status(400).json({ message: "Video file is required" });
  }


  const sourcePath = path.resolve(req.file.path);

  if (!title) {
    await discard(sourcePath);
    return res.status(400).json({ message: "Title is required" });
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    await discard(sourcePath);
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  try {
  
    let thumbnail: string | null = null;
    if (typeof thumbnailUrl === "string" && thumbnailUrl.startsWith("data:image")) {
      const uploaded = await uploadToCloudinary(thumbnailUrl, "thumbnails");
      thumbnail = uploaded.secure_url;
    }

    const [created] = await db
      .insert(video)
      .values({
        creatorId: session.user.id,
        title,
        description: description ?? null,
        thumbnailUrl: thumbnail,
        category: category ?? null,
        tags: tags ?? null,
        status: "processing",
      })
      .returning({ id: video.id });

    if (!created) {
      throw new Error("Failed to create video row");
    }

    try {
      await enqueueVideoProcessing({ videoId: created.id, sourcePath });
    } catch (queueError) {
   
      await db
        .update(video)
        .set({
          status: "failed",
          processingError:
            "Could not queue transcoding. The processing queue is unreachable.",
        })
        .where(eq(video.id, created.id))
        .catch(() => {});

      await discard(sourcePath);
      console.error("[upload] enqueue failed:", queueError);
      return res.status(503).json({
        message:
          "Upload saved but transcoding could not be queued. Please try again once the processing queue is available.",
        videoId: created.id,
        status: "failed",
      });
    }

    return res.status(202).json({
      message: "Upload accepted. Transcoding has been queued.",
      videoId: created.id,
      status: "processing",
    });
  } catch (error) {
    await discard(sourcePath);
    console.error("[upload] failed:", error);
    return res.status(500).json({ message: "Failed to accept video upload" });
  }
};

/*
 
  Client
  |
  | GET /videos/:id/status
  v
Database
  |
  +--> Video status
  |
  +--> Renditions
  |
  v
JSON response
 
*/


const getVideoStatus = async (req: Request, res: Response) => {

  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const [row] = await db
    .select({
      id: video.id,
      status: video.status,
      videoUrl: video.videoUrl,
      duration: video.duration,
      processingError: video.processingError,
    })
    .from(video)
    .where(eq(video.id, id))
    .limit(1);

  if (!row) {
    return res.status(404).json({ message: "Video not found" });
  }

  const renditions = await db
    .select({
      name: videoRendition.name,
      height: videoRendition.height,
      bandwidth: videoRendition.bandwidth,
      playlistUrl: videoRendition.playlistUrl,
    })
    .from(videoRendition)
    .where(eq(videoRendition.videoId, id));


  const progress =
    row.status === "processing" ? await getVideoJobSnapshot(id) : null;

  return res.json({
    id: row.id,
    status: row.status,
    videoUrl: row.videoUrl,
    duration: row.duration,
    renditions,
    progress,
    ...(row.status === "failed" ? { error: row.processingError } : {}),
  });
};

const discard = (filePath: string) => rm(filePath, { force: true }).catch(() => {});



const getAllUploadedVideo =async(req: Request, res: Response)=>{
    const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if(!session){
        return res.status(401).json({ message: "Unauthorized - Please sign in first" });
      }

  
      const videos = await db
        .select()
        .from(video)
        .where(eq(video.creatorId, session.user.id))
        .orderBy(desc(video.createdAt));

      return res.json({ videos });
}


const getUploadedVideoById =async(req: Request, res: Response)=>{

    const id = typeof req.params.id === "string" ? req.params.id : undefined;

      if(!id) {
        return res.status(400).json({ message: "Video id is required" });
      }
    const session = await auth.api.getSession({
        headers: fromNodeHeaders(req.headers),
      });

      if(!session){
        return res.status(401).json({ message: "Unauthorized - Please sign in first" });
      }



      const videos = await db
        .select()
        .from(video)
        .where(and(eq(video.id, id), eq(video.creatorId, session.user.id)));

      if (videos.length === 0) {
        return res.status(404).json({ message: "Video not found" });
      }

      return res.json({ videos });
}



const getAllVideo = async (req: Request, res: Response) => {
  const limit = Math.min(
    parseInt(req.query.limit as string) || 10,
    50
  );

  const cursor = req.query.cursor
    ? (req.query.cursor as string)
    : null;

 
  let visible = and(eq(video.isPublished, true), eq(video.status, "ready"));

  // `?following=true` narrows the feed to creators this viewer subscribes to.
  if (req.query.following === "true") {
    const viewer = await currentUser(req);

    if (!viewer) {
      return res
        .status(401)
        .json({ message: "Unauthorized - Please sign in first" });
    }

    visible = and(
      visible,
      inArray(
        video.creatorId,
        db
          .select({ id: subscriber.creatorId })
          .from(subscriber)
          .where(eq(subscriber.userId, viewer.id)),
      ),
    );
  }

  const queryResults: Video[] = await db
    .select()
    .from(video)
    .where(cursor ? and(visible, lt(video.id, cursor)) : visible)
    .orderBy(desc(video.id))
    .limit(limit);

  // Only hand back a cursor when the page was full. Returning the last id of a
  // short page promises a next page that does not exist.
  const nextCursor =
    queryResults.length === limit ? (queryResults.at(-1)?.id ?? null) : null;

return res.status(200).json({
  success: true,
  data: queryResults,
  meta: {
    nextCursor,
    count: queryResults.length,
  },
});
};


const getVideoById = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  // Read the session up front: it decides both whether a draft is visible and
  // what `isLiked` / `isSubscribed` mean.
  const viewer = await currentUser(req);

  const [videoData] = await db.select().from(video).where(eq(video.id, id)).limit(1);

  if (!videoData) {
    return res.status(404).json({ message: "Video not found" });
  }

  if (!videoData.isPublished || videoData.status !== "ready") {
    if (!viewer || viewer.id !== videoData.creatorId) {
      return res.status(404).json({ message: "Video not found" });
    }
  }

  const [creator] = await db
    .select({ id: user.id, name: user.name, image: user.image })
    .from(user)
    .where(eq(user.id, videoData.creatorId))
    .limit(1);

  // The watch page needs all of this at once, so it is gathered here rather
  // than leaving the client to fan out four more requests.
  const [likeCount, commentCount, isLiked, subscriberCount, isSubscribed] =
    await Promise.all([
      countLikes(id),
      countComments(id),
      hasLiked(id, viewer?.id ?? null),
      countSubscribers(videoData.creatorId),
      isSubscribedTo(videoData.creatorId, viewer?.id ?? null),
    ]);

  return res.json({
    video: videoData,
    creator: creator
      ? { ...creator, subscriberCount, isSubscribed, isSelf: viewer?.id === creator.id }
      : null,
    engagement: { likeCount, commentCount, isLiked },
  });
};


/*

  Client
  |
  | POST /videos/:id/view
  v
Published + ready check
  |
  v
view_count = view_count + 1

*/

const recordVideoView = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const [row] = await db
    .select({
      id: video.id,
      isPublished: video.isPublished,
      status: video.status,
    })
    .from(video)
    .where(eq(video.id, id))
    .limit(1);

  if (!row) {
    return res.status(404).json({ message: "Video not found" });
  }

  if (!row.isPublished || row.status !== "ready") {
    return res.status(409).json({ message: "Video is not published" });
  }

 
  const result = await db.execute(
    sql`update ${video} set view_count = view_count + 1 where ${video.id} = ${id} returning view_count`,
  );

  const rows = (result as unknown as { rows?: Array<{ view_count?: number }> }).rows ?? [];

  return res.json({ viewCount: rows[0]?.view_count ?? null });
};



/*

  Client
  |
  | PATCH /videos/:id  { title?, description?, category?, tags?, isPublished? }
  v
Ownership check
  |
  +--> Publishing requires status === "ready"
  |
  v
Database update

*/

const updateVideo = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: video.id,
      creatorId: video.creatorId,
      status: video.status,
    })
    .from(video)
    .where(eq(video.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Video not found" });
  }

  if (existing.creatorId !== session.user.id) {
    return res.status(403).json({ message: "You can only edit your own videos" });
  }

  const { title, description, category, tags, isPublished } = req.body ?? {};

  const patch: Partial<typeof video.$inferInsert> = {};

  if (typeof title === "string") {
    if (!title.trim()) {
      return res.status(400).json({ message: "Title cannot be empty" });
    }
    patch.title = title.trim();
  }

  if (typeof description === "string") patch.description = description.trim() || null;
  if (typeof category === "string") patch.category = category.trim() || null;
  if (typeof tags === "string") patch.tags = tags.trim() || null;

  if (typeof isPublished === "boolean") {
    // Publishing a half-transcoded video would put a dead player on the feed.
    if (isPublished && existing.status !== "ready") {
      return res.status(409).json({
        message: `Video is ${existing.status} and cannot be published yet`,
      });
    }
    patch.isPublished = isPublished;
  }

  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ message: "No supported fields to update" });
  }

  const [updated] = await db
    .update(video)
    .set(patch)
    .where(eq(video.id, id))
    .returning();

  return res.json({ video: updated });
};


/*

  Client
  |
  | DELETE /videos/:id
  v
Ownership check
  |
  +---- Queued job -> removed (so nothing transcodes a deleted video)
  |
  +---- Source file -> discarded
  |
  +---- HLS folder + thumbnail -> removed from Cloudinary
  |
  v
Database row deleted (renditions cascade)

*/

const deleteVideo = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  });

  if (!session) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: video.id,
      creatorId: video.creatorId,
      thumbnailUrl: video.thumbnailUrl,
    })
    .from(video)
    .where(eq(video.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Video not found" });
  }

  if (existing.creatorId !== session.user.id) {
    return res.status(403).json({ message: "You can only delete your own videos" });
  }


  const job = await removeVideoJob(id);

  if (job.data?.sourcePath) {
    await discard(path.resolve(job.data.sourcePath));
  }


  await deleteRawFolderFromCloudinary(`videos/${id}/hls`).catch((error) => {
    console.error(`[delete] cloudinary hls cleanup failed for ${id}:`, error);
  });

  if (existing.thumbnailUrl) {
    const publicId = publicIdFromUrl(existing.thumbnailUrl);
    if (publicId) {
      await deleteFromCloudinary(publicId).catch((error) => {
        console.error(`[delete] cloudinary thumbnail cleanup failed for ${id}:`, error);
      });
    }
  }


  await db.delete(video).where(eq(video.id, id));

  if (!job.removed) {
    console.warn(
      `[delete] video ${id} was deleted while its job was still running; ` +
        "the worker will error out on this job and stop.",
    );
  }

  return res.json({ id, message: "Video deleted" });
};


export { uploadVideo, getVideoStatus, getAllUploadedVideo, getUploadedVideoById, getAllVideo, getVideoById, updateVideo, recordVideoView, deleteVideo };
