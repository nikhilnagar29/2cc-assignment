// src/services/metrics.service.js
const client = require('prom-client');

// Create a Registry to register all metrics
const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

// --- Define Metrics ---

const orders_received_total = new client.Counter({
  name: 'orders_received_total',
  help: 'Total number of valid orders received by the system',
});

const orders_rejected_total = new client.Counter({
  name: 'orders_rejected_total',
  help: 'Total number of orders rejected (duplicates or invalid)',
});

const orders_matched_total = new client.Counter({
  name: 'orders_matched_total',
  help: 'Total number of matched trades executed by the engine',
});

const order_latency_seconds = new client.Histogram({
  name: 'order_latency_seconds',
  help: 'Histogram of the time it takes to process an order job (from queue to completion)',
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5] // Buckets in seconds
});

// --- Register Metrics ---
registry.registerMetric(orders_received_total);
registry.registerMetric(orders_rejected_total);
registry.registerMetric(orders_matched_total);
registry.registerMetric(order_latency_seconds);

// --- Export ---
module.exports = {
  registry,
  metrics: {
    orders_received_total,
    orders_rejected_total,
    orders_matched_total,
    order_latency_seconds
  }
};