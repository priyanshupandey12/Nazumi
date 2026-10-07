import type { Request, Response } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { video, videoCaption } from "../db/Schema.js";
import { currentUser, loadVisibleVideo } from "../lib/access.js";

/*

  Client
  |
  | GET /videos/:id/captions          -> the track list
  | GET /captions/:id/file            -> the WebVTT itself
  | POST /videos/:id/captions         -> upload a track
  | DELETE /captions/:id              -> remove one
  v
Reads follow the video's visibility; writes are the creator's alone.

*/

const MAX_VTT_BYTES = 2 * 1024 * 1024;
const MAX_LABEL = 60;
const MAX_LANGUAGE = 20;

/**
 * A `<track>` is only honoured when the file parses, and a browser gives no
 * useful error when it does not — so a malformed upload is refused here.
 */
const looksLikeVtt = (content: string) => content.trimStart().startsWith("WEBVTT");

const listCaptions = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  // Captions follow the video: public for a published one, creator-only for a
  // draft they are still working on.
  const viewer = await currentUser(req);
  const target = await loadVisibleVideo(id, viewer?.id ?? null);

  if (!target) {
    return res.status(404).json({ message: "Video not found" });
  }

  const tracks = await db
    .select({
      id: videoCaption.id,
      language: videoCaption.language,
      label: videoCaption.label,
      isDefault: videoCaption.isDefault,
      source: videoCaption.source,
    })
    .from(videoCaption)
    .where(eq(videoCaption.videoId, id))
    .orderBy(asc(videoCaption.language));

  return res.json({ captions: tracks });
};

/**
 * The WebVTT itself, served from our own origin so the player sees a correct
 * content type.
 *
 * This one is a capability URL: knowing the id is the permission. It cannot
 * check who is asking, because a `<track>` element fetches with
 * `crossorigin="anonymous"` and so never sends cookies — a creator previewing
 * their own draft would get no subtitles. The alternative,
 * `crossorigin="use-credentials"`, breaks the poster image, since Cloudinary
 * answers `Access-Control-Allow-Origin: *` and browsers reject that for a
 * credentialed request.
 *
 * What protects an unpublished transcript is that ids are uuidv7 and the only
 * way to learn one is `GET /videos/:id/captions`, which *is* scoped to the
 * video's visibility.
 */
const getCaptionFile = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Caption id is required" });
  }

  const [track] = await db
    .select({ content: videoCaption.content })
    .from(videoCaption)
    .where(eq(videoCaption.id, id))
    .limit(1);

  if (!track) {
    return res.status(404).json({ message: "Caption not found" });
  }

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.send(track.content);
};

const createCaption = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Video id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [target] = await db
    .select({ id: video.id, creatorId: video.creatorId })
    .from(video)
    .where(eq(video.id, id))
    .limit(1);

  if (!target || target.creatorId !== viewer.id) {
    return res.status(404).json({ message: "Video not found" });
  }

  const { language, label, content } = req.body ?? {};

  if (typeof language !== "string" || !language.trim()) {
    return res.status(400).json({ message: "A language is required" });
  }

  if (language.trim().length > MAX_LANGUAGE) {
    return res.status(400).json({ message: "That language code is too long" });
  }

  if (typeof label === "string" && label.trim().length > MAX_LABEL) {
    return res.status(400).json({ message: "That label is too long" });
  }

  if (typeof content !== "string" || !content.trim()) {
    return res.status(400).json({ message: "The caption file is empty" });
  }

  if (Buffer.byteLength(content, "utf8") > MAX_VTT_BYTES) {
    return res.status(413).json({ message: "That caption file is too large" });
  }

  if (!looksLikeVtt(content)) {
    return res.status(400).json({
      message: "That is not a WebVTT file. It must begin with WEBVTT.",
    });
  }

  const trimmedLanguage = language.trim();
  const existing = await db
    .select({ id: videoCaption.id })
    .from(videoCaption)
    .where(eq(videoCaption.videoId, id));

  // One track per language, so re-uploading replaces rather than stacking two
  // "English" entries in the player menu.
  const [saved] = await db
    .insert(videoCaption)
    .values({
      videoId: id,
      language: trimmedLanguage,
      label: typeof label === "string" && label.trim() ? label.trim() : trimmedLanguage,
      content,
      isDefault: existing.length === 0,
      source: "uploaded",
    })
    .onConflictDoUpdate({
      target: [videoCaption.videoId, videoCaption.language],
      set: {
        label:
          typeof label === "string" && label.trim() ? label.trim() : trimmedLanguage,
        content,
        source: "uploaded",
      },
    })
    .returning({
      id: videoCaption.id,
      language: videoCaption.language,
      label: videoCaption.label,
      isDefault: videoCaption.isDefault,
      source: videoCaption.source,
    });

  return res.status(201).json({ caption: saved });
};

const deleteCaption = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Caption id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: videoCaption.id,
      videoId: videoCaption.videoId,
      isDefault: videoCaption.isDefault,
      creatorId: video.creatorId,
    })
    .from(videoCaption)
    .innerJoin(video, eq(videoCaption.videoId, video.id))
    .where(eq(videoCaption.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Caption not found" });
  }

  if (existing.creatorId !== viewer.id) {
    return res.status(403).json({ message: "You can only edit your own videos" });
  }

  await db.delete(videoCaption).where(eq(videoCaption.id, id));

  // Removing the default would otherwise leave a video with tracks but none
  // selected, so the next one takes over.
  if (existing.isDefault) {
    const [next] = await db
      .select({ id: videoCaption.id })
      .from(videoCaption)
      .where(eq(videoCaption.videoId, existing.videoId))
      .orderBy(asc(videoCaption.language))
      .limit(1);

    if (next) {
      await db
        .update(videoCaption)
        .set({ isDefault: true })
        .where(eq(videoCaption.id, next.id));
    }
  }

  return res.json({ id });
};

/** Which track the player shows unless the viewer picks another. */
const setDefaultCaption = async (req: Request, res: Response) => {
  const id = typeof req.params.id === "string" ? req.params.id : undefined;

  if (!id) {
    return res.status(400).json({ message: "Caption id is required" });
  }

  const viewer = await currentUser(req);

  if (!viewer) {
    return res.status(401).json({ message: "Unauthorized - Please sign in first" });
  }

  const [existing] = await db
    .select({
      id: videoCaption.id,
      videoId: videoCaption.videoId,
      creatorId: video.creatorId,
    })
    .from(videoCaption)
    .innerJoin(video, eq(videoCaption.videoId, video.id))
    .where(eq(videoCaption.id, id))
    .limit(1);

  if (!existing) {
    return res.status(404).json({ message: "Caption not found" });
  }

  if (existing.creatorId !== viewer.id) {
    return res.status(403).json({ message: "You can only edit your own videos" });
  }

  await db.transaction(async (tx) => {
    await tx
      .update(videoCaption)
      .set({ isDefault: false })
      .where(eq(videoCaption.videoId, existing.videoId));

    await tx
      .update(videoCaption)
      .set({ isDefault: true })
      .where(and(eq(videoCaption.id, id)));
  });

  return res.json({ id });
};

export {
  listCaptions,
  getCaptionFile,
  createCaption,
  deleteCaption,
  setDefaultCaption,
};
