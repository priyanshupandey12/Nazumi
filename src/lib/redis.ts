import type { RedisOptions } from 'bullmq'

 export const redisConnection: RedisOptions = {
    host: process.env.REDIS_HOST as string,
    port: parseInt(process.env.REDIS_PORT as string, 10),
}



