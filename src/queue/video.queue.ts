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
