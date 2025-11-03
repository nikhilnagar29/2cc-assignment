// src/server.js
require('dotenv').config(); // MUST be first

const http = require('http');
const express = require('express');
const apiRoutes = require('./api/routes');
const orderWorker = require('./services/matching.engine');
const db = require('./config/postgres'); // <-- Import your new DB config
const broadcastService = require('./services/broadcast.service'); // 2. Import the service

// --- Bull Board UI Setup ---
const { createBullBoard } = require('@bull-board/api');
const { BullMQAdapter } = require('@bull-board/api/bullMQAdapter');
const { ExpressAdapter } = require('@bull-board/express');
const { orderQueue } = require('./config/queue');

const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

createBullBoard({
  queues: [new BullMQAdapter(orderQueue)],
  serverAdapter: serverAdapter,
});

// --- App Setup ---
const app = express();
const server = http.createServer(app);

app.use(express.json());
app.use('/', apiRoutes);
app.use('/admin/queues', serverAdapter.getRouter());

broadcastService.initialize(server);


// --- New Start Server Function ---
async function startServer() {
  try {
    // 1. Test the database connection first!
    await db.connect();
    
    // 2. If DB is OK, start the server
    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`Server is running on http://localhost:${PORT}`);
      console.log('Order processing queue is active.');
      console.log(`BullMQ UI available at http://localhost:${PORT}/admin/queues`);
      console.log(`WebSocket stream available at ws://localhost:${PORT}`); // New log
    });

  } catch (err) {
    // This catch is for any *other* startup error
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

// Call the async start function
startServer();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await orderWorker.close();
  await db.pool.end(); // Gracefully close the DB pool
  process.exit(0);
});