// src/config/queue.js
const { Queue, Worker } = require('bullmq');
const { createClient } = require('./redis');

const QUEUE_NAME = 'order-processing';

// 1. The Queue
// This is what you use to ADD jobs
const orderQueue = new Queue(QUEUE_NAME, {
  connection: createClient(),
});

// 2. The Worker
// This is what you use to PROCESS jobs
// We define the processor function in matching.engine.js
const createOrderWorker = (processor) => {
  const worker = new Worker(QUEUE_NAME, processor, {
    connection: createClient(),
    concurrency: 1, // **CRITICAL: Process only 1 job at a time**
    limiter: {      // Rate limit to match assignment targets
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