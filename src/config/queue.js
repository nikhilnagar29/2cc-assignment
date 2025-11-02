// src/config/queue.js
const { Queue, Worker } = require('bullmq');
// Import the createClient function
const { createClient } = require('./redis'); 

const QUEUE_NAME = 'order-processing';

// 1. The Queue — used to ADD jobs
const orderQueue = new Queue(QUEUE_NAME, {
  // --- THIS IS THE FIX ---
  // Give it its own, new connection
  connection: createClient(), 
});

// 2. The Worker — used to PROCESS jobs
const createOrderWorker = (processor) => {
  const worker = new Worker(QUEUE_NAME, processor, {
    // --- THIS IS THE FIX ---
    // Give the worker its own, separate connection
    connection: createClient(), 
    
    concurrency: 1,          // CRITICAL: one job at a time
    limiter: {               // Rate limit to match assignment load
      max: 2000,
      duration: 1000,
    },
  });

  worker.on('completed', (job) => {
    console.log(`Job ${job.id} completed successfully`);
  });

  worker.on('failed', (job, err) => {
    console.error(`Job ${job.id} failed with error: ${err.message}`);
  });

  return worker;
};

module.exports = {
  orderQueue,
  createOrderWorker,
};