"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisRateLimiter = void 0;
const local_rate_limiter_1 = require("./local-rate-limiter");
const rate_limiter_flexible_1 = require("rate-limiter-flexible");
const Redis = require('ioredis');
class RedisRateLimiter extends local_rate_limiter_1.LocalRateLimiter {
    constructor(server) {
        super(server);
        this.server = server;
        let redisOptions = {
            ...server.options.database.redis,
            ...server.options.rateLimiter.redis.redisOptions,
        };
        this.redisConnection = server.options.rateLimiter.redis.clusterMode
            ? new Redis.Cluster(server.options.database.redis.clusterNodes, {
                scaleReads: 'slave',
                redisOptions,
            })
            : new Redis(redisOptions);
    }
    initializeRateLimiter(appId, eventKey, maxPoints) {
        return Promise.resolve(new rate_limiter_flexible_1.RateLimiterRedis({
            points: maxPoints,
            duration: 1,
            storeClient: this.redisConnection,
            keyPrefix: `app:${appId}`,
        }));
    }
    disconnect() {
        this.redisConnection.disconnect();
        return Promise.resolve();
    }
}
exports.RedisRateLimiter = RedisRateLimiter;
