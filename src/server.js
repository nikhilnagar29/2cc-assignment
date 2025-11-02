import express from 'express'
const apiRoutes = require('./api/routes');
const orderWorker = require('./services/matching.engine'); // This import *starts* the worker

// --- App Setup ---
const app = express();
app.use(express.json()); // Middleware to parse JSON bodies

// --- API Routes ---
app.use('/', apiRoutes);

// --- Start Server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
  console.log('Order processing queue is active.');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received. Shutting down gracefully...');
  await orderWorker.close();
  // ... close DB pool, etc.
  process.exit(0);
});