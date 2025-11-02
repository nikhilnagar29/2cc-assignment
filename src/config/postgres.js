// src/db.js
// This file configures and exports your Postgres connection pool

const { Pool } = require('pg');

// The pool will automatically use the environment variables
// we set in docker-compose.yml:
// - POSTGRES_USER
// - POSTGRES_HOST
// - POSTGRES_DB
// - POSTGRES_PASSWORD
const pool = new Pool({
  // You can add more specific configs here if needed,
  // but the defaults from env vars are usually enough.
  max: 20, // Max number of clients in the pool
  idleTimeoutMillis: 30000, // How long a client is allowed to be idle
  connectionTimeoutMillis: 2000, // How long to wait for a connection
});

// Optional: Add a listener for connection errors
pool.on('error', (err, client) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

console.log('Postgres connection pool created.');

// Export a query function that will be used by all your services
module.exports = {
  /**
   * @param {string} text The SQL query text
   * @param {Array<any>} params The parameters for the query
   */
  query: (text, params) => pool.query(text, params),

  // Export the pool itself if you need to manually manage clients (e.g., for transactions)
  getPool: () => pool,
};