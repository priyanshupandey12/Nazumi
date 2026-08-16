import {Worker} from "bullmq";
import {redisConnection} from "../lib/redis.js";


const videoWorker = new Worker("video-processing", async (job) => {
    console.log(`Processing job ${job.id} of type ${job.name}`);
    // Simulate video processing
},{connection: redisConnection})


videoWorker.on("completed", (job) => {
    console.log(`Job ${job.id} completed successfully`);
});

videoWorker.on("failed", (job, err) => {
    console.log("Job failed with data:", job?.id, job?.data, "Error:", err);
});