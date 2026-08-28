import { Queue } from "bullmq";
import { redisConnection } from "../lib/redis.js";

export const VIDEO_QUEUE_NAME = "video-processing";
export const PROCESS_VIDEO_JOB = "processVideo";

export type ProcessVideoJob = {
  videoId: string;
  sourcePath: string;
};

export const videoQueue = new Queue<ProcessVideoJob>(VIDEO_QUEUE_NAME, {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 30_000 },
    removeOnComplete: { age: 24 * 3600, count: 100 },
    removeOnFail: { age: 7 * 24 * 3600 },
  },
});


export const videoJobId = (videoId: string) => `video-${videoId}`;

export const enqueueVideoProcessing = (data: ProcessVideoJob) =>
  videoQueue.add(PROCESS_VIDEO_JOB, data, {
    jobId: videoJobId(data.videoId),
  });




export const VIDEO_JOB_PHASES = [
  "queued",
  "transcoding",
  "uploading",
  "finalizing",
] as const;

export type VideoJobPhase = (typeof VIDEO_JOB_PHASES)[number];

export type VideoJobProgress = {
  phase: VideoJobPhase;

  percent: number;
};

export type VideoJobSnapshot = VideoJobProgress & {
 
  state: string;
  attemptsMade: number;
  attemptsAllowed: number;

  queuedAt: number | null;

  startedAt: number | null;

  lastError: string | null;
};

const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Math.round(value)));

const isPhase = (value: unknown): value is VideoJobPhase =>
  typeof value === "string" &&
  (VIDEO_JOB_PHASES as readonly string[]).includes(value);

const emptySnapshot = (state: string): VideoJobSnapshot => ({
  phase: "queued",
  percent: 0,
  state,
  attemptsMade: 0,
  attemptsAllowed: 0,
  queuedAt: null,
  startedAt: null,
  lastError: null,
});


export const getVideoJobSnapshot = async (
  videoId: string,
): Promise<VideoJobSnapshot> => {
  let job;
  try {
    job = await videoQueue.getJob(videoJobId(videoId));
  } catch {
    return emptySnapshot("unavailable");
  }

  if (!job) return emptySnapshot("missing");

  const state = await job.getState().catch(() => "unknown");
  const raw = job.progress;

  let percent = 0;
  let phase: VideoJobPhase = "queued";

  if (typeof raw === "number") {

    percent = raw;
    phase =
      raw >= 100 ? "finalizing" : raw >= 70 ? "uploading" : raw > 0 ? "transcoding" : "queued";
  } else if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    if (typeof record.percent === "number") percent = record.percent;
    if (isPhase(record.phase)) phase = record.phase;
  }

  return {
    percent: clampPercent(percent),
    phase,
    state,
    attemptsMade: job.attemptsMade,
    attemptsAllowed: job.opts.attempts ?? 1,
    queuedAt: typeof job.timestamp === "number" ? job.timestamp : null,
    startedAt: typeof job.processedOn === "number" ? job.processedOn : null,
    lastError: job.failedReason ? String(job.failedReason).slice(0, 500) : null,
  };
};
