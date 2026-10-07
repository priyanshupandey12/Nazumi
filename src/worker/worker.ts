import "dotenv/config";
import path from "node:path";
import os from "node:os";
import { rm, mkdir, stat, readFile } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { redisConnection } from "../lib/redis.js";
import { db } from "../db/db.js";
import { video, videoRendition, videoThumbnail, videoCaption } from "../db/Schema.js";
import {
  deleteRawFolderFromCloudinary,
  deleteImageFolderFromCloudinary,
  uploadImageToCloudinary,
} from "../utils/cloudinary.js";
import { transcodeToHls, extractThumbnails, extractCaptions } from "./ffmpeg.js";
import { uploadHlsDirectory } from "./hls.upload.js";
import { VIDEO_QUEUE_NAME, type ProcessVideoJob } from "../queue/video.queue.js";
import { notifyTranscodeFinished } from "../lib/notify.js";
import { startLiveMonitor } from "./live.monitor.js";


const CONCURRENCY = Number(process.env.VIDEO_WORKER_CONCURRENCY ?? 1);


const WORK_ROOT = path.resolve(process.env.VIDEO_WORK_DIR ?? "./tmp/transcode");

const processVideo = async (job: Job<ProcessVideoJob>) => {
  const { videoId, sourcePath } = job.data;

  if (!videoId || !sourcePath) {
    throw new Error("Job is missing videoId or sourcePath.");
  }


  await assertReadable(sourcePath);

  const outputDir = path.join(WORK_ROOT, videoId);
  const cloudinaryPrefix = `videos/${videoId}/hls`;
  const thumbnailPrefix = `videos/${videoId}/thumbs`;

  try {
    await rm(outputDir, { recursive: true, force: true });

    log(job, "transcoding");

    await job.updateProgress({ phase: "transcoding", percent: 0 });
    const result = await transcodeToHls(sourcePath, outputDir, (percent) => {
      void job.updateProgress({
        phase: "transcoding",
        percent: Math.round(percent * 0.7),
      });
    });

    log(
      job,
      `encoded ${result.rungs.map((r) => r.name).join(", ")} ` +
        `from ${result.metadata.width}x${result.metadata.height}`,
    );

    log(job, "uploading");
    const uploaded = await uploadHlsDirectory(
      outputDir,
      result.rungs,
      cloudinaryPrefix,
      (percent) => {
        void job.updateProgress({
          phase: "uploading",
          percent: 70 + Math.round(percent * 0.29),
        });
      },
    );


    // Poster frames, before the transaction so a Cloudinary hiccup here cannot
    // roll back a transcode that actually succeeded.
    const posters = await collectPosters(
      job,
      sourcePath,
      outputDir,
      result.metadata.durationSeconds,
      thumbnailPrefix,
    );

    // Subtitle tracks already inside the upload, converted to WebVTT.
    const captions = await collectCaptions(
      job,
      sourcePath,
      outputDir,
      result.metadata.subtitles,
    );

    await db.transaction(async (tx) => {
      await tx.delete(videoRendition).where(eq(videoRendition.videoId, videoId));
      await tx.insert(videoRendition).values(
        uploaded.variants.map((variant) => ({
          videoId,
          name: variant.name,
          height: variant.height,
          bandwidth: variant.bandwidth,
          playlistUrl: variant.playlistUrl,
          segmentCount: variant.segmentCount,
        })),
      );
      await tx.delete(videoThumbnail).where(eq(videoThumbnail.videoId, videoId));
      if (posters.length > 0) {
        await tx.insert(videoThumbnail).values(
          posters.map((poster) => ({
            videoId,
            url: poster.url,
            position: poster.position,
          })),
        );
      }

      // Only embedded ones are replaced; a track the creator uploaded by hand
      // survives a re-transcode.
      await tx
        .delete(videoCaption)
        .where(
          and(eq(videoCaption.videoId, videoId), eq(videoCaption.source, "embedded")),
        );

      if (captions.length > 0) {
        await tx
          .insert(videoCaption)
          .values(
            captions.map((caption, index) => ({
              videoId,
              language: caption.language,
              label: caption.label,
              content: caption.content,
              isDefault: index === 0,
              source: "embedded" as const,
            })),
          )
          .onConflictDoNothing();
      }

      const [current] = await tx
        .select({ thumbnailUrl: video.thumbnailUrl })
        .from(video)
        .where(eq(video.id, videoId))
        .limit(1);

      await tx
        .update(video)
        .set({
          videoUrl: uploaded.masterPlaylistUrl,
          duration: result.metadata.durationSeconds,
          status: "ready",
          processingError: null,
          // Only fills a gap. A thumbnail the creator chose at upload is never
          // overwritten by a generated one.
          ...(current?.thumbnailUrl || posters.length === 0
            ? {}
            : { thumbnailUrl: posters[0]!.url }),
        })
        .where(eq(video.id, videoId));
    });

    await job.updateProgress({ phase: "finalizing", percent: 100 });

    const [owner] = await db
      .select({ creatorId: video.creatorId })
      .from(video)
      .where(eq(video.id, videoId))
      .limit(1);

    if (owner) {
      await notifyTranscodeFinished({
        creatorId: owner.creatorId,
        videoId,
        outcome: "ready",
      });
    }

    log(job, `ready -> ${uploaded.masterPlaylistUrl}`);

    return {
      videoId,
      masterPlaylistUrl: uploaded.masterPlaylistUrl,
      renditions: uploaded.variants.map((v) => v.name),
      durationSeconds: result.metadata.durationSeconds,
    };
  } catch (error) {
   
    await deleteRawFolderFromCloudinary(cloudinaryPrefix).catch((cleanupError) => {
      log(job, `cloudinary cleanup failed: ${message(cleanupError)}`);
    });
    await deleteImageFolderFromCloudinary(thumbnailPrefix).catch((cleanupError) => {
      log(job, `poster cleanup failed: ${message(cleanupError)}`);
    });
    throw error;
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
};


const discardSource = async (job: Job<ProcessVideoJob>) => {
  const { sourcePath } = job.data;
  if (!sourcePath) return;

  await rm(sourcePath, { force: true }).catch((error) => {
    log(job, `could not remove source "${sourcePath}": ${message(error)}`);
  });
};

/**
 * Grabs poster frames and uploads them.
 *
 * Never throws: a video with no poster is worth shipping, and failing a
 * finished transcode over a missing thumbnail would be a poor trade.
 */
const collectPosters = async (
  job: Job<ProcessVideoJob>,
  sourcePath: string,
  outputDir: string,
  durationSeconds: number,
  prefix: string,
): Promise<Array<{ url: string; position: number }>> => {
  try {
    const frames = await extractThumbnails(
      sourcePath,
      path.join(outputDir, "thumbs"),
      durationSeconds,
    );

    const uploaded: Array<{ url: string; position: number }> = [];

    for (const frame of frames) {
      try {
        const result = await uploadImageToCloudinary(
          frame.path,
          `${prefix}/${frame.position}`,
        );
        uploaded.push({ url: result.secure_url, position: frame.position });
      } catch (error) {
        log(job, `poster ${frame.position} upload failed: ${message(error)}`);
      }
    }

    if (uploaded.length > 0) log(job, `captured ${uploaded.length} poster frames`);

    return uploaded;
  } catch (error) {
    log(job, `poster capture failed: ${message(error)}`);
    return [];
  }
};

/**
 * Reads any embedded subtitle tracks off disk as WebVTT text.
 *
 * Never throws: a video without captions is still a video, and losing a
 * finished transcode over a subtitle stream would be a poor trade.
 */
const collectCaptions = async (
  job: Job<ProcessVideoJob>,
  sourcePath: string,
  outputDir: string,
  subtitles: Awaited<ReturnType<typeof transcodeToHls>>["metadata"]["subtitles"],
): Promise<Array<{ language: string; label: string; content: string }>> => {
  if (subtitles.length === 0) return [];

  try {
    const tracks = await extractCaptions(
      sourcePath,
      path.join(outputDir, "captions"),
      subtitles,
    );

    const collected: Array<{ language: string; label: string; content: string }> = [];

    for (const track of tracks) {
      try {
        const content = await readFile(track.path, "utf8");
        if (content.trim().startsWith("WEBVTT")) {
          collected.push({ language: track.language, label: track.label, content });
        }
      } catch (error) {
        log(job, `caption ${track.language} unreadable: ${message(error)}`);
      }
    }

    if (collected.length > 0) {
      log(job, `captured ${collected.length} caption track(s)`);
    }

    return collected;
  } catch (error) {
    log(job, `caption extraction failed: ${message(error)}`);
    return [];
  }
};

const worker = new Worker<ProcessVideoJob>(VIDEO_QUEUE_NAME, processVideo, {
  connection: redisConnection,
  concurrency: CONCURRENCY,
  lockDuration: 5 * 60 * 1000,
  stalledInterval: 60 * 1000,
});

worker.on("ready", () => {
  console.log(
    `[worker] listening on "${VIDEO_QUEUE_NAME}" ` +
      `(concurrency ${CONCURRENCY}, ${os.cpus().length} cpus, work dir ${WORK_ROOT})`,
  );
});

worker.on("completed", async (job) => {
  await discardSource(job);
  console.log(`[worker] job ${job.id} completed`);
});

worker.on("failed", async (job, error) => {
  console.error(`[worker] job ${job?.id} failed: ${message(error)}`);
  if (!job) return;

  const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
  if (attemptsLeft > 0) {
    console.log(`[worker] job ${job.id} will retry (${attemptsLeft} attempt(s) left)`);
    return;
  }


  const videoId = job.data?.videoId;
  if (!videoId) return;

  const [failed] = await db
    .update(video)
    .set({ status: "failed", processingError: message(error).slice(0, 1000) })
    .where(eq(video.id, videoId))
    .returning({ creatorId: video.creatorId })
    .catch((dbError) => {
      console.error(`[worker] could not mark video ${videoId} failed: ${message(dbError)}`);
      return [];
    });

  // A failure is exactly when the creator needs telling, since there is
  // nothing on the feed to notice.
  if (failed) {
    await notifyTranscodeFinished({
      creatorId: failed.creatorId,
      videoId,
      outcome: "failed",
    });
  }


  await rm(job.data.sourcePath, { force: true }).catch(() => {});
});

worker.on("error", (error) => {
  console.error(`[worker] ${message(error)}`);
});

const assertReadable = async (filePath: string) => {
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) {
      throw new Error("not a readable file");
    }
  } catch (error) {
    throw new Error(`Source file "${filePath}" is unavailable: ${message(error)}`);
  }
};

const log = (job: Job, text: string) => console.log(`[worker] job ${job.id}: ${text}`);

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);


for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    console.log(`[worker] ${signal} received, draining...`);
    stopLiveMonitor();
    await worker.close();
    process.exit(0);
  });
}

await mkdir(WORK_ROOT, { recursive: true });

// The long-running process is the natural home for this: it watches the media
// server and keeps stream status honest without the API holding a timer.
const stopLiveMonitor = startLiveMonitor();

export { worker };
