// src/config/redis.js
// This file configures and exports your Redis client using ioredis

const IORedis = require('ioredis');

// The client will automatically use the environment variables
// we set in docker-compose.yml:
// - REDIS_HOST
// - REDIS_PORT
const redisClient = new IORedis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    // Reconnect with an exponential backoff
    return Math.min(times * 50, 2000);
  },
});

redisClient.on('connect', () => {
  console.log('Redis client connected.');
});

redisClient.on('error', (err) => {
  console.error('Redis client error:', err);
});

// Export the connected client
module.exports = redisClient;