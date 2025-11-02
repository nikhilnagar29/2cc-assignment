// src/config/redis.js
const IORedis = require('ioredis');

const redisOptions = {
  host: process.env.REDIS_HOST || 'localhost', // Use 'redis' (docker-compose service name)
  port: process.env.REDIS_PORT || 6379,
  
  // --- THIS IS THE FIX FOR YOUR CRASH ---
  // BullMQ manages its own retries, so ioredis must not.
  maxRetriesPerRequest: null, 
  
  retryStrategy(times) {
    // Reconnect with an exponential backoff
    return Math.min(times * 50, 2000);
  },
};

// 1. A client for general app use (e.g., in persistence.service.js)
const redisConnection = new IORedis(redisOptions);

redisConnection.on('connect', () => {
  console.log('Main Redis client connected.');
});

redisConnection.on('error', (err) => {
  console.error('Main Redis client error:', err);
});

// Export both the main client AND a function to create new ones
module.exports = {
  connection: redisConnection,
  
  /**
   * BullMQ requires a *new* client instance for each Queue and Worker.
   * This function provides them.
   */
  createClient: () => new IORedis(redisOptions),
};