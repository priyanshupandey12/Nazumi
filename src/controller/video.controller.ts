import path from "node:path";
import { rm } from "node:fs/promises";
import type { Request, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { eq } from "drizzle-orm";
import { auth } from "../lib/auth.js";
import { db } from "../db/db.js";
import { video, videoRendition } from "../db/Schema.js";
import { uploadToCloudinary } from "../utils/cloudinary.js";
import { enqueueVideoProcessing } from "../queue/video.queue.js";

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

    await enqueueVideoProcessing({ videoId: created.id, sourcePath });

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

  return res.json({
    id: row.id,
    status: row.status,
    videoUrl: row.videoUrl,
    duration: row.duration,
    renditions,
    ...(row.status === "failed" ? { error: row.processingError } : {}),
  });
};

const discard = (filePath: string) => rm(filePath, { force: true }).catch(() => {});

export { uploadVideo, getVideoStatus };
