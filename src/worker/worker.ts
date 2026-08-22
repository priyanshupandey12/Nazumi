import "dotenv/config";
import path from "node:path";
import os from "node:os";
import { rm, mkdir, stat } from "node:fs/promises";
import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { redisConnection } from "../lib/redis.js";
import { db } from "../db/db.js";
import { video, videoRendition } from "../db/Schema.js";
import { deleteRawFolderFromCloudinary } from "../utils/cloudinary.js";
import { transcodeToHls } from "./ffmpeg.js";
import { uploadHlsDirectory } from "./hls.upload.js";
import { VIDEO_QUEUE_NAME, type ProcessVideoJob } from "../queue/video.queue.js";


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

  try {
    await rm(outputDir, { recursive: true, force: true });

    log(job, "transcoding");
    const result = await transcodeToHls(sourcePath, outputDir, (percent) => {

      void job.updateProgress(Math.round(percent * 0.7));
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
        void job.updateProgress(70 + Math.round(percent * 0.29));
      },
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
      await tx
        .update(video)
        .set({
          videoUrl: uploaded.masterPlaylistUrl,
          duration: result.metadata.durationSeconds,
          status: "ready",
          processingError: null,
        })
        .where(eq(video.id, videoId));
    });

    await job.updateProgress(100);
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
    throw error;
  } finally {
    await rm(outputDir, { recursive: true, force: true }).catch(() => {});
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

worker.on("completed", (job) => {
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

  await db
    .update(video)
    .set({ status: "failed", processingError: message(error).slice(0, 1000) })
    .where(eq(video.id, videoId))
    .catch((dbError) => {
      console.error(`[worker] could not mark video ${videoId} failed: ${message(dbError)}`);
    });


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
    await worker.close();
    process.exit(0);
  });
}

await mkdir(WORK_ROOT, { recursive: true });

export { worker };
