const db = require('../config/postgres');
const redis = require('../config/redis').connection;

/**
 * Checks the health of the database and Redis.
 * @returns {Promise<object>} An object with the status of services.
 */ 
 
async function checkHealth() {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    postgres: 'down',
    redis: 'down'
  };

  // 1. Check Postgres
  try {
    await db.query('SELECT 1');
    health.postgres = 'ok';
  } catch (e) {
    health.status = 'error';
    console.error('Health check failed for Postgres:', e.message);
  }

  // 2. Check Redis
  try {
    const reply = await redis.ping();
    if (reply === 'PONG') {
      health.redis = 'ok';
    }
  } catch (e) {
    health.status = 'error';
    console.error('Health check failed for Redis:', e.message);
  }
  
  if (health.status === 'error') {
    throw new Error(JSON.stringify(health));
  }

  return health;
}

// --- Add the new function to your exports ---
module.exports = {
  checkHealth // <-- ADD THIS
};