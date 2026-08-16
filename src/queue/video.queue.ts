import {Queue} from "bullmq";
import {redisConnection} from "../lib/redis.js";

export const videoQueue = new Queue("video-processing", {
     connection: redisConnection
    }
)