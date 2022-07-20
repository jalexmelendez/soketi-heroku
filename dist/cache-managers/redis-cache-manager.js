"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RedisCacheManager = void 0;
const Redis = require('ioredis');
class RedisCacheManager {
    constructor(server) {
        this.server = server;
        let redisOptions = {
            ...server.options.database.redis,
            ...server.options.cache.redis.redisOptions,
        };
        this.redisConnection = server.options.cache.redis.clusterMode
            ? new Redis.Cluster(server.options.database.redis.clusterNodes, {
                scaleReads: 'slave',
                redisOptions,
            })
            : new Redis(redisOptions);
    }
    has(key) {
        return this.get(key).then(result => {
            return result ? true : false;
        });
    }
    get(key) {
        return new Promise(resolve => {
            this.redisConnection.get(key, (err, result) => {
                if (err || !result) {
                    resolve(null);
                }
                else {
                    resolve(result);
                }
            });
        });
    }
    set(key, value, ttlSeconds = -1) {
        if (ttlSeconds > 0) {
            this.redisConnection.set(key, value, 'EX', ttlSeconds);
        }
        else {
            this.redisConnection.set(key, value);
        }
        return Promise.resolve(true);
    }
    disconnect() {
        this.redisConnection.disconnect();
        return Promise.resolve();
    }
}
exports.RedisCacheManager = RedisCacheManager;
