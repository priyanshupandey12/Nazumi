import type { RedisOptions } from 'bullmq'

 export const redisConnection: RedisOptions = {
    host: process.env.REDIS_HOST as string,
    port: parseInt(process.env.REDIS_PORT as string, 10),
    // Tests point at a separate index so a run cannot touch real jobs.
    db: Number(process.env.REDIS_DB ?? 0),
}



