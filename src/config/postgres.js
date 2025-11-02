// src/config/postgres.js
const { Pool } = require('pg');

// 1. --- EXPLICITLY read the env vars ---
// This fixes the POSTGRES_ vs PG_ bug.
const pool = new Pool({
  user: process.env.POSTGRES_USER,
  host: process.env.POSTGRES_HOST,
  database: process.env.POSTGRES_DB,
  password: process.env.POSTGRES_PASSWORD,
  port: parseInt(process.env.POSTGRES_PORT || '5432'), // Ensure port is a number
  
  // Pool configuration
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// 2. --- Log errors from idle clients ---
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle Postgres client', err);
  process.exit(-1);
});

// 3. --- Export the pool and a query function ---
module.exports = {
  // Export the pool for advanced use (like transactions)
  pool,
  
  /**
   * Dedicated query function.
   * @param {string} text The SQL query text
   * @param {Array<any>} params The parameters for the query
   */
  query: (text, params) => pool.query(text, params),

  /**
   * 4. --- EXPORT A CONNECTION TESTER ---
   * We will call this from server.js *before* starting the app.
   */
  connect: async () => {
    try {
      await pool.query('SELECT NOW()'); // A simple, fast query to test auth
      console.log('Postgres connection pool created and connection tested.');
    } catch (err) {
      console.error('CRITICAL: Failed to connect to Postgres database.', err.stack);
      process.exit(1); // Exit the app if we can't connect to the DB
    }
  }
};